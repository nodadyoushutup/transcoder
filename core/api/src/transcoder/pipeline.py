"""Higher-level orchestration helpers for FFmpeg DASH encoding."""
from __future__ import annotations

import logging
import shutil
import threading
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from collections import defaultdict
from pathlib import Path
from typing import Iterable, List, Optional, Set

import subprocess

from .encoder import FFmpegDashEncoder
from .exceptions import PublisherError
from .publishing import NoOpPublisher, SegmentPublisher

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class DashSegmentTracker:
    """Track previously-published segments and compute incremental updates."""

    output_dir: Path
    _seen: Set[Path] = field(default_factory=set, init=False)

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def all_segments(self, mpd_path: Path) -> List[Path]:
        return _collect_segment_files(self.output_dir, mpd_path)

    def new_segments(self, mpd_path: Path) -> List[Path]:
        segments = self.all_segments(mpd_path)
        fresh: List[Path] = []
        for segment in segments:
            if segment in self._seen:
                continue
            try:
                if segment.stat().st_size == 0:
                    # Skip zero-byte artifacts until FFmpeg finishes writing them.
                    LOGGER.debug("Segment %s is zero bytes; deferring publish", segment)
                    continue
            except OSError:
                LOGGER.debug("Unable to stat segment %s; will retry", segment)
                continue
            fresh.append(segment)
        self._seen.update(fresh)
        return fresh

    def forget(self, paths: Iterable[Path]) -> None:
        resolved = {Path(path).expanduser().resolve() for path in paths}
        self._seen.difference_update(resolved)


@dataclass(slots=True)
class LiveEncodingHandle:
    """Wrap the running FFmpeg process and optional publisher thread."""

    process: 'subprocess.Popen[str]'
    publisher_thread: Optional[threading.Thread] = None

    def wait(self) -> int:
        """Block until the FFmpeg process exits."""

        return self.process.wait()




@dataclass(slots=True)
class SegmentPruner:
    """Delete stale DASH segments so the output directory mirrors the live window."""

    output_dir: Path
    retain_per_representation: int
    basename: str

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.retain_per_representation = max(1, int(self.retain_per_representation))

    def prune(self) -> tuple[list[Path], set[Path]]:
        removed: list[Path] = []
        kept: set[Path] = set()
        if not self.output_dir.exists():
            return removed, kept

        segments = defaultdict(list)
        for path in self.output_dir.rglob('*.m4s'):
            rep_id, number = _parse_segment_metadata(path, self.basename)
            if rep_id is None or number is None:
                continue
            segments[rep_id].append((number, path))

        for items in segments.values():
            items.sort(key=lambda pair: pair[0])
            keep_items = items[-self.retain_per_representation :]
            kept.update(path for _, path in keep_items)
            for _, path in items[:-self.retain_per_representation]:
                try:
                    path.unlink()
                    removed.append(path)
                except OSError:
                    LOGGER.warning("Failed to delete stale segment: %s", path)

        return removed, kept

class DashTranscodePipeline:
    """Combine the encoder with optional publishing strategies."""

    def __init__(
        self,
        encoder: FFmpegDashEncoder,
        publisher: SegmentPublisher | None = None,
        poll_interval: float = 2.0,
        session_prefix: Optional[str] = None,
    ) -> None:
        self.encoder = encoder
        self.publisher = publisher or NoOpPublisher()
        self.poll_interval = poll_interval
        if session_prefix is None:
            session_prefix = encoder.settings.session_segment_prefix
        self._session_prefix = session_prefix.strip("/") if session_prefix else None
        self._output_dir = self.encoder.settings.output_dir.expanduser().resolve()
        if self._session_prefix:
            session_dir = (self.encoder.settings.output_dir / self._session_prefix).expanduser().resolve()
        else:
            session_dir = self.encoder.settings.output_dir
        self._session_dir = session_dir
        self._session_dir.mkdir(parents=True, exist_ok=True)
        dash_opts = self.encoder.settings.dash
        retain = dash_opts.retention_segments
        if retain is None:
            retain = max(dash_opts.window_size + dash_opts.extra_window_size, dash_opts.window_size)
        self._segment_pruner = SegmentPruner(
            self._session_dir,
            retain_per_representation=max(1, retain),
            basename=self.encoder.settings.output_basename,
        )
        self._published_static_assets: Set[Path] = set()

    def run_vod(self, publish: bool = True) -> 'subprocess.CompletedProcess[str]':
        """Execute FFmpeg to completion and optionally publish all segments afterwards."""

        result = self.encoder.run_to_completion(check=True)
        if publish:
            self.publish_all()
        return result

    def publish_all(self) -> None:
        """Publish every segment currently present in the output directory."""

        mpd_path = self.encoder.settings.mpd_path
        if not mpd_path.exists():
            raise PublisherError(f"Manifest not found at {mpd_path}")
        segments = _collect_segment_files(self.encoder.settings.output_dir, mpd_path)
        LOGGER.info("Publishing %d segments via %s", len(segments), self.publisher.__class__.__name__)
        snapshot = self._snapshot_manifest(mpd_path)
        self.publisher.publish(mpd_path, segments, mpd_snapshot=snapshot)

    def cleanup_output(self) -> list[Path]:
        """Remove DASH artifacts from the output directory and notify the publisher."""

        removed: list[Path] = []
        output_dir = self.encoder.settings.output_dir
        if not output_dir.exists():
            return removed

        patterns = ("*.mpd", "*.m4s", "*.m4a", "*.m4v", "*.mp4", "*.tmp")
        for pattern in patterns:
            for path in output_dir.glob(pattern):
                if not path.is_file():
                    continue
                try:
                    path.unlink()
                    removed.append(path)
                except OSError:
                    LOGGER.warning("Failed to delete DASH artifact: %s", path)

        if removed:
            try:
                self.publisher.remove(removed)
            except PublisherError:
                LOGGER.exception("Failed to remove published DASH artifacts")

        static_assets = list(self._published_static_assets)
        if static_assets:
            try:
                self.publisher.remove(static_assets)
            except PublisherError:
                LOGGER.exception("Failed to remove published static assets")
            else:
                LOGGER.info("Requested removal of %d static asset(s)", len(static_assets))
            finally:
                self._published_static_assets.clear()

        return removed

    def start_live(
        self,
        poll_interval: Optional[float] = None,
        static_assets: Optional[Iterable[Path]] = None,
    ) -> LiveEncodingHandle:
        """Start FFmpeg for live streaming and publish segments as they appear."""

        interval = poll_interval or self.poll_interval
        process = self.encoder.start()

        tracker = DashSegmentTracker(self._session_dir)
        mpd_path = self.encoder.settings.mpd_path
        pending_static: set[Path] = set()
        if static_assets:
            for asset in static_assets:
                path = Path(asset).expanduser().resolve()
                if path.exists():
                    pending_static.add(path)

        def publisher_loop() -> None:
            manifest_sent = False
            manifest_logged = False
            while True:
                if mpd_path.exists():
                    if not manifest_logged:
                        try:
                            mpd_stat = mpd_path.stat()
                            mpd_age_ms = max(0.0, (time.time() - mpd_stat.st_mtime) * 1000)
                            LOGGER.info(
                                "Detected manifest %s size=%d age_ms=%.2f",
                                mpd_path.name,
                                mpd_stat.st_size,
                                mpd_age_ms,
                            )
                        except OSError:
                            LOGGER.warning("Manifest %s discovered but stat() failed", mpd_path)
                        manifest_logged = True
                    try:
                        new_segments = self._filter_session_segments(tracker.new_segments(mpd_path))
                        if new_segments:
                            LOGGER.info(
                                "Discovered %d new segment(s): %s",
                                len(new_segments),
                                "; ".join(
                                    _format_segment_details(
                                        path,
                                        self.encoder.settings.output_basename,
                                    )
                                    for path in new_segments
                                ),
                            )
                        publish_needed = bool(new_segments)
                        if not manifest_sent and not publish_needed:
                            LOGGER.debug(
                                "Manifest %s available but no publishable segments yet; deferring",
                                mpd_path.name,
                            )
                        if publish_needed and not isinstance(self.publisher, NoOpPublisher):
                            LOGGER.info(
                                "Publishing %d new segment(s) (manifest sent=%s)",
                                len(new_segments),
                                manifest_sent,
                            )
                            snapshot_path = self._snapshot_manifest(mpd_path)
                            LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                            self.publisher.publish(
                                mpd_path,
                                new_segments,
                                mpd_snapshot=snapshot_path,
                            )
                            manifest_sent = True
                        elif publish_needed:
                            if not manifest_sent:
                                LOGGER.info("Manifest available locally; no remote publisher configured")
                            manifest_sent = True
                        if pending_static and not isinstance(self.publisher, NoOpPublisher):
                            ready = [
                                asset for asset in list(pending_static)
                                if asset.exists() and self._is_session_path(asset)
                            ]
                            if ready:
                                LOGGER.info(
                                    "Publishing %d static subtitle asset(s)",
                                    len(ready),
                                )
                                snapshot_path = self._snapshot_manifest(mpd_path)
                                LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                                self.publisher.publish(
                                    mpd_path,
                                    ready,
                                    mpd_snapshot=snapshot_path,
                                )
                                self._mark_static_assets_published(ready)
                                pending_static.difference_update(ready)
                    except PublisherError:
                        LOGGER.exception("Failed to publish DASH segments")

                    removed, _kept = self._segment_pruner.prune()
                    if removed:
                        LOGGER.info(
                            "Pruned %d stale segment(s): %s",
                            len(removed),
                            ", ".join(path.name for path in removed),
                        )
                        tracker.forget(removed)
                        try:
                            self.publisher.remove(removed)
                        except PublisherError:
                            LOGGER.exception("Failed to remove published DASH segments")
                if process.poll() is not None:
                    LOGGER.info("FFmpeg process exited with code %s", process.returncode)
                    # Final flush on shutdown
                    if mpd_path.exists():
                        try:
                            remaining = self._filter_session_segments(tracker.new_segments(mpd_path))
                            if remaining and not isinstance(self.publisher, NoOpPublisher):
                                LOGGER.info(
                                    "Publishing %d remaining segment(s) during shutdown",
                                    len(remaining),
                                )
                                snapshot_path = self._snapshot_manifest(mpd_path)
                                LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                                self.publisher.publish(
                                    mpd_path,
                                    remaining,
                                    mpd_snapshot=snapshot_path,
                                )
                            if pending_static and not isinstance(self.publisher, NoOpPublisher):
                                ready = [
                                    asset for asset in list(pending_static)
                                    if asset.exists() and self._is_session_path(asset)
                                ]
                                if ready:
                                    LOGGER.info(
                                        "Publishing %d remaining static asset(s) during shutdown",
                                        len(ready),
                                    )
                                    snapshot_path = self._snapshot_manifest(mpd_path)
                                    LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                                    self.publisher.publish(
                                        mpd_path,
                                        ready,
                                        mpd_snapshot=snapshot_path,
                                    )
                                    self._mark_static_assets_published(ready)
                                    pending_static.difference_update(ready)
                            removed, _kept = self._segment_pruner.prune()
                            if removed:
                                LOGGER.info("Pruned %d stale segment(s) during shutdown", len(removed))
                                tracker.forget(removed)
                                try:
                                    self.publisher.remove(removed)
                                except PublisherError:
                                    LOGGER.exception("Failed to remove published DASH segments")
                        except PublisherError:
                            LOGGER.exception("Failed to publish remaining DASH segments")
                    break
                time.sleep(interval)

        thread = threading.Thread(target=publisher_loop, name="dash-publisher", daemon=True)
        thread.start()
        LOGGER.info("Started live FFmpeg process with %s publisher", self.publisher.__class__.__name__)
        return LiveEncodingHandle(process, thread)

    def _mark_static_assets_published(self, assets: Iterable[Path]) -> None:
        for asset in assets:
            try:
                resolved = Path(asset).expanduser().resolve()
            except Exception:
                continue
            self._published_static_assets.add(resolved)

    def _is_session_path(self, path: Path) -> bool:
        try:
            resolved = Path(path).expanduser().resolve()
        except Exception:
            return False
        try:
            relative = resolved.relative_to(self._output_dir)
        except ValueError:
            return False

        if not self._session_prefix:
            return True

        prefix_parts = Path(self._session_prefix).parts
        if len(relative.parts) < len(prefix_parts):
            return False
        if tuple(relative.parts[: len(prefix_parts)]) != prefix_parts:
            return False
        return True

    def _filter_session_segments(self, segments: Iterable[Path]) -> list[Path]:
        filtered: list[Path] = []
        for segment in segments:
            try:
                resolved = Path(segment).expanduser().resolve()
            except Exception:
                continue

            if resolved.name == f"{self.encoder.settings.output_basename}.mpd":
                filtered.append(resolved)
                continue

            if self._is_session_path(resolved):
                filtered.append(segment)
            else:
                LOGGER.debug("Skipping retained session segment: %s", segment)
        return filtered

    def _snapshot_manifest(self, mpd_path: Path) -> Path:
        resolved_mpd = Path(mpd_path).expanduser().resolve()
        if not resolved_mpd.exists():
            raise PublisherError(f"Cannot snapshot missing manifest at {resolved_mpd}")
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        history_dir = resolved_mpd.parent / "mpd-history"
        history_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = history_dir / f"{resolved_mpd.stem}-{timestamp}{resolved_mpd.suffix}"
        shutil.copy2(resolved_mpd, snapshot_path)
        return snapshot_path


def _collect_segment_files(output_dir: Path, mpd_path: Path) -> List[Path]:
    files: List[Path] = []
    output_dir = Path(output_dir).expanduser().resolve()
    if not output_dir.exists():
        return files
    mpd_path = mpd_path.expanduser().resolve()
    for path in sorted(output_dir.rglob('*')):
        if path.is_dir():
            continue
        resolved = path.expanduser().resolve()
        if resolved == mpd_path:
            continue
        if resolved.suffix == '.tmp':
            continue
        files.append(resolved)
    return files


def _parse_segment_metadata(path: Path, basename: str) -> tuple[Optional[str], Optional[int]]:
    name = path.name
    chunk_prefix = f"{basename}_chunk_"
    if chunk_prefix in name:
        try:
            remainder = name.split('_chunk_', 1)[1]
            rep_part, number_part = remainder.rsplit('_', 1)
            number_str = number_part.split('.', 1)[0]
            return rep_part, int(number_str)
        except (ValueError, IndexError):  # pragma: no cover - defensive parsing
            return None, None
    if name.startswith('chunk-'):
        remainder = name[6:]
        rep_part, _, tail = remainder.partition('-')
        if not rep_part or not tail:
            return None, None
        number_str, _, _ = tail.partition('.')
        if not number_str:
            return None, None
        try:
            return rep_part, int(number_str)
        except ValueError:  # pragma: no cover - defensive parsing
            return None, None
    return None, None


def _format_segment_details(path: Path, basename: str) -> str:
    try:
        stat = path.stat()
    except OSError:
        return f"{path.name} (stat-failed)"

    rep_id, number = _parse_segment_metadata(path, basename)
    rep_display = rep_id if rep_id is not None else "?"
    seq_display = str(number) if number is not None else "?"
    age_ms = max(0.0, (time.time() - stat.st_mtime) * 1000)
    mtime_iso = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
    return (
        f"{path.name} rep={rep_display} seq={seq_display} "
        f"size={stat.st_size} age_ms={age_ms:.2f} mtime={mtime_iso}"
    )
