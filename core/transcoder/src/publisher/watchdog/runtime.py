"""Runtime helpers for the WebDAV upload watchdog."""
from __future__ import annotations

import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from threading import Event
from typing import Optional

from watchdog.events import DirMovedEvent, FileMovedEvent, FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from ..queue_worker import UploadManager
from ..storage import WebDavStorage

LOGGER = logging.getLogger("transcoder.publisher.watchdog")


@dataclass
class WatchdogConfig:
    """Configuration values that drive the watchdog runtime."""

    output_dir: Path
    upload_url: str
    manifest_delay: float
    manifest_timeout: float
    max_workers: int
    retry_attempts: int
    retry_backoff: float
    request_timeout: float
    backfill_window: float


class UploadEventHandler(FileSystemEventHandler):
    """React to filesystem events and delegate uploads."""

    def __init__(self, manager: UploadManager) -> None:
        super().__init__()
        self._manager = manager

    def on_closed(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = Path(event.src_path)
        if not path.exists():
            return
        self._manager.submit(path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        path = Path(event.src_path)
        self._manager.delete(path, is_directory=event.is_directory)

    def on_moved(self, event: FileSystemEvent) -> None:
        if not isinstance(event, (FileMovedEvent, DirMovedEvent)):
            return
        src = Path(event.src_path)
        self._manager.delete(src, is_directory=event.is_directory)
        if event.is_directory:
            return
        dest = Path(event.dest_path)
        if dest.exists():
            self._manager.submit(dest)


def configure_logging() -> Optional[Path]:
    """Initialise module-level logging for the watchdog."""

    log_level = os.getenv("WATCHDOG_LOG_LEVEL", "DEBUG").upper()
    numeric_level = getattr(logging, log_level, logging.INFO)

    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)

    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    root_logger.addHandler(stream_handler)

    log_dir_env = os.getenv("WATCHDOG_LOG_DIR") or os.getenv(
        "TRANSCODER_SERVICE_LOG_DIR")
    log_path: Optional[Path] = None
    if log_dir_env:
        try:
            log_dir = Path(log_dir_env).expanduser()
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / \
                f"watchdog-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.log"
            file_handler = logging.FileHandler(log_path, encoding="utf-8")
            file_handler.setFormatter(formatter)
            root_logger.addHandler(file_handler)
        except Exception:  # pragma: no cover - defensive
            root_logger.warning(
                "Failed to initialise watchdog file logger", exc_info=True)
            log_path = None

    if log_path:
        root_logger.info("Watchdog logging to %s", log_path)
    else:
        root_logger.debug("Watchdog file logging disabled; streaming only")
    return log_path


def load_config_from_env() -> WatchdogConfig:
    """Return WatchdogConfig populated from environment variables."""

    output_dir = Path(
        os.getenv("WATCHDOG_OUTPUT_DIR")
        or os.getenv("TRANSCODER_OUTPUT")
        or os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
        or str(Path.home() / "transcode_data")
    ).expanduser()

    upload_url = (
        os.getenv("WATCHDOG_UPLOAD_URL")
        or os.getenv("TRANSCODER_PUBLISH_BASE_URL")
        or "http://localhost:5005/media"
    )

    config = WatchdogConfig(
        output_dir=output_dir,
        upload_url=upload_url,
        manifest_delay=_parse_float(
            os.getenv("WATCHDOG_MANIFEST_DELAY"), default=2.0),
        manifest_timeout=_parse_float(
            os.getenv("WATCHDOG_MANIFEST_TIMEOUT"), default=15.0),
        max_workers=max(1, _parse_int(
            os.getenv("WATCHDOG_WORKERS"), default=4)),
        retry_attempts=max(1, _parse_int(
            os.getenv("WATCHDOG_RETRY_ATTEMPTS"), default=3)),
        retry_backoff=max(1.0, _parse_float(
            os.getenv("WATCHDOG_RETRY_BACKOFF"), default=1.5)),
        request_timeout=max(5.0, _parse_float(
            os.getenv("WATCHDOG_REQUEST_TIMEOUT"), default=30.0)),
        backfill_window=max(0.0, _parse_float(
            os.getenv("WATCHDOG_BACKFILL_WINDOW_SECONDS"), default=300.0)),
    )
    return config


def run_watchdog(*, stop_event: Optional[Event] = None) -> int:
    """Run the upload watchdog until interrupted."""

    configure_logging()
    cfg = load_config_from_env()

    cfg.output_dir.mkdir(parents=True, exist_ok=True)

    headers: dict[str, str] = {}
    effective_stop_event = stop_event or Event()

    storage = WebDavStorage(
        upload_base=cfg.upload_url,
        headers=headers,
        request_timeout=cfg.request_timeout,
        retry_attempts=cfg.retry_attempts,
        retry_backoff=cfg.retry_backoff,
    )

    manager = UploadManager(
        output_dir=cfg.output_dir,
        storage=storage,
        manifest_delay=cfg.manifest_delay,
        manifest_timeout=cfg.manifest_timeout,
        max_workers=cfg.max_workers,
        stop_event=effective_stop_event,
    )

    if cfg.backfill_window > 0:
        try:
            queued = _backfill_recent_assets(
                manager, window_seconds=cfg.backfill_window)
            if queued:
                LOGGER.info(
                    "Queued %d existing artefact(s) for upload (window=%.1fs)",
                    queued,
                    cfg.backfill_window,
                )
        except Exception:  # pragma: no cover - defensive
            LOGGER.warning("Initial WebDAV backfill failed", exc_info=True)

    handler = UploadEventHandler(manager)
    observer = _observe(cfg.output_dir, handler)

    def _signal_handler(signum: int, _frame: object) -> None:
        LOGGER.info("Signal %s received; shutting down watchdog", signum)
        effective_stop_event.set()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    try:
        while not effective_stop_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        LOGGER.info("Keyboard interrupt received; stopping watchdog")
        effective_stop_event.set()
    finally:
        observer.stop()
        observer.join(timeout=5.0)
        manager.shutdown()
    return 0


# ----------------------------------------------------------------------
# Internal helpers
# ----------------------------------------------------------------------
def _observe(output_dir: Path, handler: FileSystemEventHandler) -> Observer:
    observer = Observer()
    observer.schedule(handler, str(output_dir), recursive=True)
    observer.start()
    LOGGER.info("Watching %s for closed file events", output_dir)
    return observer


def _parse_float(value: Optional[str], default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_int(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _backfill_recent_assets(manager: UploadManager, *, window_seconds: float) -> int:
    """Queue existing files for upload when the watchdog starts."""

    if window_seconds <= 0:
        return 0

    cutoff = time.time() - window_seconds
    output_dir = manager.output_dir
    LOGGER.info(
        "Scanning %s for artefacts modified since %.0fs ago",
        output_dir,
        window_seconds,
    )
    segment_candidates: list[tuple[float, Path]] = []
    manifest_candidates: list[tuple[float, Path]] = []
    manifest_exts = {ext.lower() for ext in UploadManager.MANIFEST_EXTENSIONS}
    temp_prefix = UploadManager.PACKAGER_TEMP_PREFIX

    for path in output_dir.rglob("*"):
        if path.is_dir() or path.is_symlink():
            continue
        try:
            relative = path.relative_to(output_dir)
        except ValueError:
            continue
        if not relative.parts:
            continue
        if relative.parts[0] == ".pipes":
            continue
        suffix = path.suffix.lower()
        if suffix == ".tmp":
            continue
        if any(part.startswith(temp_prefix) for part in relative.parts):
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime < cutoff:
            continue
        target = segment_candidates
        if suffix in manifest_exts:
            target = manifest_candidates
        target.append((mtime, path))

    segment_candidates.sort(key=lambda item: item[0])
    manifest_candidates.sort(key=lambda item: item[0])

    for _, path in segment_candidates:
        manager.submit(path)
    for _, path in manifest_candidates:
        manager.submit(path)

    return len(segment_candidates) + len(manifest_candidates)


__all__ = ["WatchdogConfig", "configure_logging",
           "load_config_from_env", "run_watchdog"]
