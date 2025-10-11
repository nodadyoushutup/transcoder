"""Runtime controller that powers the standalone transcoder microservice."""
from __future__ import annotations

import logging
import threading
from typing import Any, List, Mapping, Optional

from transcoder import DashTranscodePipeline, EncoderSettings, LiveEncodingHandle

from .heartbeat import HeartbeatLoop
from .runner import RunCallbacks, SubtitleCollection, TranscodeRunner
from .session_manager import SessionContext, SessionManager
from .status import TranscoderStatusBroadcaster
from .status_snapshot import TranscoderStatus
from .stop_strategy import StopStrategy
from .subtitles import SubtitleService
from ..utils import ensure_trailing_slash

LOGGER = logging.getLogger(__name__)


class TranscoderController:
    """Coordinate starting and stopping the FFmpeg-based transcoder."""

    def __init__(
        self,
        *,
        local_media_base: Optional[str] = None,
        status_broadcaster: Optional[TranscoderStatusBroadcaster] = None,
        heartbeat_interval: int = 5,
        session_retention: int = 2,
        subtitle_service: Optional[SubtitleService] = None,
        runner: Optional[TranscodeRunner] = None,
        stop_strategy: Optional[StopStrategy] = None,
    ) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._handle: Optional[LiveEncodingHandle] = None
        self._pipeline: Optional[DashTranscodePipeline] = None
        self._state: str = "idle"
        self._last_error: Optional[str] = None
        self._latest_settings: Optional[EncoderSettings] = None
        self._publish_url: Optional[str] = None
        self._local_media_base = ensure_trailing_slash(local_media_base)
        self._subtitle_service = subtitle_service or SubtitleService()
        self._runner = runner or TranscodeRunner(self._subtitle_service)
        self._stopper = stop_strategy or StopStrategy()
        self._subtitle_tracks: List[Mapping[str, Any]] = []
        self._status_broadcaster = status_broadcaster
        self._heartbeat_interval = max(1, int(heartbeat_interval))
        self._heartbeat = HeartbeatLoop(self._heartbeat_interval, self._broadcast_status)
        self._session_manager = SessionManager(retention=session_retention)
        self._active_session: Optional[SessionContext] = None

    def start(
        self,
        settings: EncoderSettings,
        publish_url: Optional[str] = None,
        subtitle_metadata: Optional[Mapping[str, Any]] = None,
        session: Optional[Mapping[str, Any]] = None,
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

        normalized_publish = ensure_trailing_slash(publish_url)
        session_payload = session if isinstance(session, Mapping) else None
        session_context = self._session_manager.begin(settings, session_payload)
        session_id = session_context.session_id
        retain_sessions = list(session_context.retain_sessions)
        session_prefix = session_context.session_prefix

        if session_id:
            LOGGER.info(
                "Transcoder session %s starting (retain=%s)",
                session_id,
                ",".join(retain_sessions) if retain_sessions else "none",
            )
        with self._lock:
            self._active_session = session_context

        subtitle_collection: SubtitleCollection = self._runner.collect_subtitles(
            settings=settings,
            publish_url=normalized_publish,
            subtitle_metadata=subtitle_metadata if isinstance(subtitle_metadata, Mapping) else None,
        )

        with self._lock:
            self._subtitle_tracks = list(subtitle_collection.tracks)

        self._broadcast_status()

        def _on_started(handle: LiveEncodingHandle, pipeline: DashTranscodePipeline) -> None:
            with self._lock:
                self._handle = handle
                self._latest_settings = settings
                self._state = "running"
                self._publish_url = normalized_publish
                self._pipeline = pipeline
                self._subtitle_tracks = list(subtitle_collection.tracks)
            self._broadcast_status()

        def _on_completed(
            handle: Optional[LiveEncodingHandle],
            pipeline: Optional[DashTranscodePipeline],
            error: Optional[BaseException],
        ) -> None:
            if error:
                with self._lock:
                    self._last_error = str(error)
                    self._state = "error"
                self._broadcast_status()

            self._cleanup_pipeline_output(pipeline, context="post-run")

            with self._lock:
                self._handle = None
                self._thread = None
                self._publish_url = None
                self._pipeline = None
                self._active_session = None
                if not error and self._state != "error":
                    self._state = "idle"
            self._session_manager.complete(session_context)
            self._stop_heartbeat()
            self._broadcast_status()

        callbacks = RunCallbacks(on_started=_on_started, on_completed=_on_completed)
        thread = self._runner.launch(
            settings=settings,
            session_prefix=session_prefix,
            subtitle_assets=subtitle_collection.assets,
            callbacks=callbacks,
        )
        with self._lock:
            self._thread = thread
        self._start_heartbeat()
        self._broadcast_status()
        return True

    def stop(self) -> bool:
        """Request shutdown of the running transcoder."""

        with self._lock:
            handle = self._handle
            thread = self._thread
            pipeline = self._pipeline
            active_context = self._active_session
            if handle is None or thread is None or not thread.is_alive():
                LOGGER.debug("No active transcoder run to stop")
                return False
            self._state = "stopping"
        self._broadcast_status()

        self._stopper.shutdown(handle)
        thread.join(timeout=5)
        handle.cleanup()

        self._cleanup_pipeline_output(pipeline, context="stop")

        with self._lock:
            self._handle = None
            self._thread = None
            self._pipeline = None
            self._active_session = None
            self._publish_url = None
            if self._state != "error":
                self._state = "idle"
        self._session_manager.complete(active_context)
        self._stop_heartbeat()
        self._broadcast_status()
        return True

    def status(self, local_base_override: Optional[str] = None) -> TranscoderStatus:
        """Return an immutable snapshot of controller state."""

        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            pid = self._handle.process.pid if self._handle else None
            packager_pid = (
                self._handle.packager_process.pid
                if self._handle and self._handle.packager_process
                else None
            )
            settings = self._latest_settings
            manifest = str(settings.mpd_path) if settings else None
            output_dir = str(settings.output_dir) if settings else None
            current_session = self._session_manager.current_session_id
            manifest_url = None
            if settings and manifest:
                manifest_name = settings.mpd_path.name
                base_url = self._publish_url
                if not base_url:
                    base_url = ensure_trailing_slash(local_base_override) or self._local_media_base
                if base_url:
                    manifest_url = base_url + manifest_name
            status = TranscoderStatus(
                state=self._state,
                running=running,
                pid=pid,
                packager_pid=packager_pid,
                output_dir=output_dir,
                output_manifest=manifest,
                last_error=self._last_error,
                publish_base_url=self._publish_url,
                manifest_url=manifest_url,
                subtitle_tracks=list(self._subtitle_tracks),
                session_id=current_session,
            )
        return status

    def prepare_subtitles(
        self,
        settings: EncoderSettings,
        publish_url: Optional[str],
        subtitle_metadata: Mapping[str, Any],
    ) -> List[Mapping[str, Any]]:
        """Extract subtitle tracks synchronously and return metadata."""

        with self._lock:
            if self._thread and self._thread.is_alive():
                raise RuntimeError("transcoder is currently running")
            self._state = "preparing_subtitles"
            self._subtitle_tracks = []
            self._last_error = None
        self._broadcast_status()

        normalized_publish = ensure_trailing_slash(publish_url)
        try:
            collection = self._runner.collect_subtitles(
                settings=settings,
                publish_url=normalized_publish,
                subtitle_metadata=subtitle_metadata,
                suppress_errors=False,
            )
            tracks = collection.tracks
            with self._lock:
                self._subtitle_tracks = list(tracks)
            LOGGER.info(
                "Prepared %d subtitle track(s) for rating=%s part=%s",
                len(tracks),
                subtitle_metadata.get("rating_key"),
                subtitle_metadata.get("part_id"),
            )
            self._broadcast_status()
            return tracks
        except Exception as exc:
            LOGGER.warning("Subtitle preparation failed: %s", exc)
            with self._lock:
                self._last_error = str(exc)
            self._broadcast_status()
            raise
        finally:
            with self._lock:
                if not (self._thread and self._thread.is_alive()):
                    self._state = "idle"
            self._broadcast_status()

    def broadcast_status(self) -> None:
        """Force an immediate status broadcast if configured."""

        self._broadcast_status()

    def _broadcast_status(self) -> None:
        broadcaster = self._status_broadcaster
        if broadcaster is None or not broadcaster.available:
            return
        try:
            broadcaster.publish(self.status())
        except Exception:  # pragma: no cover - defensive
            LOGGER.debug("Failed to broadcast transcoder status", exc_info=True)

    def _cleanup_pipeline_output(self, pipeline: Optional[DashTranscodePipeline], *, context: str) -> None:
        if pipeline is None:
            LOGGER.debug("Skipping %s cleanup: no active pipeline", context)
            return
        if context == "post-run":
            LOGGER.debug("Skipping %s cleanup to preserve manifest for session handoff", context)
            return
        try:
            removed = pipeline.cleanup_output()
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.exception("Failed to clean DASH artifacts during %s", context)
            return

        output_dir = pipeline.encoder.settings.output_dir
        if removed:
            LOGGER.info(
                "Removed %d DASH artifact(s) during %s cleanup (output=%s)",
                len(removed),
                context,
                output_dir,
            )
        else:
            LOGGER.info(
                "No DASH artifacts found during %s cleanup (output=%s)",
                context,
                output_dir,
            )

    def _start_heartbeat(self) -> None:
        broadcaster = self._status_broadcaster
        if broadcaster is None or not broadcaster.available:
            return
        self._heartbeat.start()

    def _stop_heartbeat(self) -> None:
        self._heartbeat.stop()
