"""Runtime controller that powers the standalone transcoder microservice."""
from __future__ import annotations

import logging
import signal
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Mapping, Optional

from transcoder import (
    DashTranscodePipeline,
    EncoderSettings,
    FFmpegDashEncoder,
    HttpPutPublisher,
    LiveEncodingHandle,
)

from .subtitle_service import SubtitleService

LOGGER = logging.getLogger(__name__)


@dataclass
class TranscoderStatus:
    """Snapshot of the controller's current state."""

    state: str
    running: bool
    pid: Optional[int]
    output_dir: Optional[str]
    output_manifest: Optional[str]
    last_error: Optional[str]
    publish_base_url: Optional[str]
    manifest_url: Optional[str]
    subtitle_tracks: Optional[List[Mapping[str, Any]]]


class TranscoderController:
    """Coordinate starting and stopping the FFmpeg-based transcoder."""

    def __init__(
        self,
        local_media_base: Optional[str] = None,
        publish_force_new_connection: bool = False,
    ) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._handle: Optional[LiveEncodingHandle] = None
        self._pipeline: Optional[DashTranscodePipeline] = None
        self._state: str = "idle"
        self._last_error: Optional[str] = None
        self._latest_settings: Optional[EncoderSettings] = None
        self._publish_url: Optional[str] = None
        self._local_media_base = _normalize_base_url(local_media_base)
        self._publish_force_new_connection_default = publish_force_new_connection
        self._subtitle_service = SubtitleService()
        self._subtitle_tracks: List[Mapping[str, Any]] = []

    def start(
        self,
        settings: EncoderSettings,
        publish_url: Optional[str] = None,
        force_new_connection: Optional[bool] = None,
        subtitle_metadata: Optional[Mapping[str, Any]] = None,
    ) -> bool:
        """Start the transcoder in a background thread.

        Returns ``False`` if a run is already active.
        """

        with self._lock:
            if self._thread and self._thread.is_alive():
                LOGGER.debug("Transcoder already running; start request ignored")
                return False
            self._state = "starting"
            self._last_error = None

        normalized_publish = publish_url.rstrip('/') + '/' if publish_url else None
        subtitle_tracks: List[Mapping[str, Any]] = []
        subtitle_assets: List[Path] = []
        if subtitle_metadata:
            try:
                subtitle_tracks, subtitle_assets = self._subtitle_service.collect_tracks(
                    rating_key=str(subtitle_metadata.get("rating_key") or "unknown"),
                    part_id=subtitle_metadata.get("part_id"),
                    input_path=settings.input_path,
                    output_dir=settings.output_dir,
                    publish_base_url=normalized_publish,
                )
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning("Subtitle extraction failed: %s", exc)
        with self._lock:
            self._subtitle_tracks = subtitle_tracks

        def runner() -> None:
            try:
                if not normalized_publish:
                    raise ValueError("publish base URL is required for transcoder runs")
                encoder = FFmpegDashEncoder(settings)
                effective_force_new_conn = (
                    self._publish_force_new_connection_default
                    if force_new_connection is None
                    else bool(force_new_connection)
                )
                publisher = HttpPutPublisher(
                    base_url=normalized_publish,
                    source_root=settings.output_dir,
                    enable_delete=True,
                    force_new_connection=effective_force_new_conn,
                )
                pipeline = DashTranscodePipeline(encoder, publisher=publisher)
                handle = pipeline.start_live(static_assets=subtitle_assets)
                with self._lock:
                    self._handle = handle
                    self._latest_settings = settings
                    self._state = "running"
                    self._publish_url = normalized_publish
                    self._pipeline = pipeline
                    self._subtitle_tracks = subtitle_tracks
                LOGGER.info("Started transcoder process (pid=%s)", handle.process.pid)
                handle.wait()
                LOGGER.info("Transcoder exited with %s", handle.process.returncode)
            except Exception as exc:  # pragma: no cover - defensive, relies on FFmpeg
                LOGGER.exception("Transcoder run failed")
                with self._lock:
                    self._last_error = str(exc)
                    self._state = "error"
            finally:
                with self._lock:
                    self._handle = None
                    self._thread = None
                    self._publish_url = None
                    self._pipeline = None
                    self._subtitle_tracks = []
                    if self._state != "error":
                        self._state = "idle"

        thread = threading.Thread(target=runner, name="transcoder-runner", daemon=True)
        with self._lock:
            self._thread = thread
        thread.start()
        return True

    def stop(self) -> bool:
        """Request shutdown of the running transcoder."""

        with self._lock:
            handle = self._handle
            thread = self._thread
            pipeline = self._pipeline
            if handle is None or thread is None or not thread.is_alive():
                LOGGER.debug("No active transcoder run to stop")
                return False
            self._state = "stopping"

        try:
            LOGGER.info("Sending SIGINT to transcoder (pid=%s)", handle.process.pid)
            handle.process.send_signal(signal.SIGINT)
        except Exception as exc:  # pragma: no cover - system dependent
            LOGGER.exception("Failed to signal transcoder process: %s", exc)

        handle.wait()
        if handle.publisher_thread:
            handle.publisher_thread.join(timeout=5)
        thread.join(timeout=5)

        removed_artifacts: list[str] = []
        if pipeline is not None:
            cleaned = pipeline.cleanup_output()
            if cleaned:
                removed_artifacts = [str(path) for path in cleaned]
                LOGGER.info(
                    "Removed %d DASH artifacts from %s",
                    len(removed_artifacts),
                    pipeline.encoder.settings.output_dir,
                )

        with self._lock:
            self._handle = None
            self._thread = None
            self._pipeline = None
            if self._state != "error":
                self._state = "idle"
        return True

    def status(self, local_base_override: Optional[str] = None) -> TranscoderStatus:
        """Return an immutable snapshot of controller state."""

        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            pid = self._handle.process.pid if self._handle else None
            settings = self._latest_settings
            manifest = str(settings.mpd_path) if settings else None
            output_dir = str(settings.output_dir) if settings else None
            manifest_url = None
            if settings and manifest:
                manifest_name = settings.mpd_path.name
                base_url = self._publish_url
                if not base_url:
                    base_url = _normalize_base_url(local_base_override) or self._local_media_base
                if base_url:
                    manifest_url = base_url + manifest_name
            status = TranscoderStatus(
                state=self._state,
                running=running,
                pid=pid,
                output_dir=output_dir,
                output_manifest=manifest,
                last_error=self._last_error,
                publish_base_url=self._publish_url,
                manifest_url=manifest_url,
                subtitle_tracks=list(self._subtitle_tracks),
            )
        return status


def _normalize_base_url(base: Optional[str]) -> Optional[str]:
    if not base:
        return None
    trimmed = base.strip()
    if not trimmed:
        return None
    return trimmed.rstrip('/') + '/'
