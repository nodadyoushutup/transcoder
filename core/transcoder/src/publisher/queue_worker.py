"""Background upload queue that coordinates WebDAV operations."""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Condition, Event, Lock
from typing import Optional

from ..utils import sleep_with_stop
from .storage import WebDavStorage

LOGGER = logging.getLogger("transcoder.publisher.queue")


class UploadManager:
    """Coordinate manifest and segment uploads via a worker pool."""

    MANIFEST_EXTENSIONS = {".mpd", ".m3u8"}
    PACKAGER_TEMP_PREFIX = "packager-tempfile-"

    def __init__(
        self,
        *,
        output_dir: Path,
        storage: WebDavStorage,
        manifest_delay: float,
        manifest_timeout: float,
        max_workers: int,
        stop_event: Optional[Event] = None,
    ) -> None:
        self.output_dir = output_dir.expanduser().resolve()
        self.storage = storage
        self.manifest_delay = max(0.0, manifest_delay)
        self.manifest_timeout = max(1.0, manifest_timeout)
        self.stop_event = stop_event or Event()

        self._executor = ThreadPoolExecutor(max_workers=max(1, max_workers))
        self._lock = Lock()
        self._condition = Condition(self._lock)
        self._segment_sequence = 0
        self._inflight_segments: dict[int, Path] = {}
        self._retry_base_delay = 1.0
        self._retry_backoff_factor = max(1.0, getattr(self.storage, "retry_backoff", 1.5))
        self._retry_max_delay = 30.0

        LOGGER.info(
            "Upload manager initialised (output=%s workers=%d)",
            self.output_dir,
            max(1, max_workers),
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        LOGGER.debug("Upload manager shutting down")
        self.stop_event.set()
        self._executor.shutdown(wait=True, cancel_futures=True)
        self.storage.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def submit(self, path: Path) -> None:
        try:
            relative = path.relative_to(self.output_dir)
        except ValueError:
            LOGGER.debug("Skipping %s: outside of output dir %s", path, self.output_dir)
            return

        suffix = path.suffix.lower()
        if suffix in self.MANIFEST_EXTENSIONS:
            if self._is_packager_temp(relative):
                LOGGER.debug("Skipping packager temp manifest %s", relative)
                return
            marker = self._current_segment_marker()
            LOGGER.debug("Scheduling manifest upload for %s (marker=%d)", relative, marker)
            self._executor.submit(self._upload_manifest, path, relative, marker)
            return

        if suffix == ".tmp":
            LOGGER.debug("Skipping temp file %s", relative)
            return

        if self._is_packager_temp(relative):
            LOGGER.debug("Skipping packager temp file %s", relative)
            return

        token = self._register_segment(relative)
        LOGGER.debug("Scheduling segment upload for %s (token=%d)", relative, token)
        self._executor.submit(self._upload_segment, path, relative, token)

    def delete(self, path: Path, *, is_directory: bool) -> None:
        try:
            relative = path.relative_to(self.output_dir)
        except ValueError:
            LOGGER.debug("Skipping delete for %s: outside of output dir %s", path, self.output_dir)
            return

        if not relative.parts:
            LOGGER.debug("Skipping delete for root output directory %s", path)
            return

        if not is_directory and relative.suffix.lower() == ".tmp":
            LOGGER.debug("Skipping delete for temp file %s", relative)
            return

        LOGGER.debug(
            "Scheduling %s delete for %s",
            "directory" if is_directory else "file",
            relative,
        )
        self._executor.submit(self.storage.delete_path, relative, is_directory=is_directory, stop_event=self.stop_event)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _upload_segment(self, path: Path, relative: Path, token: int) -> None:
        attempts = 0
        uploaded = False
        try:
            while not self.stop_event.is_set():
                attempts += 1
                uploaded = self.storage.upload_file(
                    kind="segment",
                    path=path,
                    relative=relative,
                    stop_event=self.stop_event,
                )
                if uploaded:
                    break
                if not path.exists():
                    LOGGER.warning(
                        "Segment disappeared before upload succeeded: %s",
                        relative,
                    )
                    break
                delay = self._next_retry_delay(attempts)
                LOGGER.warning(
                    "Segment upload failed; retrying in %.1fs (cycle=%d, %s)",
                    delay,
                    attempts,
                    relative,
                )
                self._sleep_with_stop(delay)
        finally:
            if not uploaded and not self.stop_event.is_set():
                LOGGER.warning(
                    "Segment upload exhausted after %d cycle(s); giving up on %s",
                    attempts,
                    relative,
                )
            with self._condition:
                self._inflight_segments.pop(token, None)
                self._condition.notify_all()

    def _upload_manifest(self, path: Path, relative: Path, marker: int) -> None:
        LOGGER.debug("Waiting %.2fs before manifest upload for %s", self.manifest_delay, relative)
        self._sleep_with_stop(self.manifest_delay)
        self._await_segments(marker)
        attempts = 0
        uploaded = False
        while not self.stop_event.is_set():
            attempts += 1
            uploaded = self.storage.upload_file(
                kind="manifest",
                path=path,
                relative=relative,
                stop_event=self.stop_event,
            )
            if uploaded:
                break
            if not path.exists():
                LOGGER.warning(
                    "Manifest no longer present; aborting upload for %s",
                    relative,
                )
                break
            delay = self._next_retry_delay(attempts)
            LOGGER.warning(
                "Manifest upload failed; retrying in %.1fs (cycle=%d, %s)",
                delay,
                attempts,
                relative,
            )
            self._sleep_with_stop(delay)
        if not uploaded and not self.stop_event.is_set():
            LOGGER.warning(
                "Manifest upload exhausted after %d cycle(s); giving up on %s",
                attempts,
                relative,
            )

    def _register_segment(self, relative: Path) -> int:
        with self._condition:
            self._segment_sequence += 1
            token = self._segment_sequence
            self._inflight_segments[token] = relative
            return token

    def _current_segment_marker(self) -> int:
        with self._condition:
            return self._segment_sequence

    def _await_segments(self, marker: int) -> None:
        deadline = time.monotonic() + self.manifest_timeout
        with self._condition:
            while any(token <= marker for token in self._inflight_segments):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.stop_event.is_set():
                    LOGGER.warning(
                        "Manifest wait timed out (marker=%d inflight=%d)",
                        marker,
                        len(self._inflight_segments),
                    )
                    break
                self._condition.wait(timeout=min(remaining, 0.5))

    def _is_packager_temp(self, relative: Path) -> bool:
        return any(part.startswith(self.PACKAGER_TEMP_PREFIX) for part in relative.parts)

    def _sleep_with_stop(self, seconds: float) -> None:
        sleep_with_stop(seconds, self.stop_event)

    def _next_retry_delay(self, cycle: int) -> float:
        scale = max(1, cycle)
        delay = self._retry_base_delay * (self._retry_backoff_factor ** (scale - 1))
        return min(delay, self._retry_max_delay)


__all__ = ["UploadManager"]
