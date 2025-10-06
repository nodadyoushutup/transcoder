"""Runtime controller that powers the standalone transcoder microservice."""
from __future__ import annotations

import logging
import signal
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from subprocess import TimeoutExpired
from typing import TYPE_CHECKING, Any, Iterable, List, Mapping, Optional

from transcoder import (
    DashTranscodePipeline,
    EncoderSettings,
    FFmpegDashEncoder,
    HttpPutPublisher,
    LiveEncodingHandle,
)

from .status_broadcaster import TranscoderStatusBroadcaster
from .subtitle_service import SubtitleService

if TYPE_CHECKING:  # pragma: no cover - typing helper
    from threading import Event

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
    session_id: Optional[str] = None

    def to_session(
        self,
        *,
        log_file: Optional[str] = None,
        origin: Optional[str] = None,
        updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """Render a session dictionary for API responses."""

        subtitles: list[dict[str, Any]] = []
        if self.subtitle_tracks:
            for track in self.subtitle_tracks:
                if isinstance(track, Mapping):
                    subtitles.append(dict(track))

        session: dict[str, Any] = {
            "state": self.state,
            "running": self.running,
            "pid": self.pid,
            "output_dir": self.output_dir,
            "output_manifest": self.output_manifest,
            "last_error": self.last_error,
            "publish_base_url": self.publish_base_url,
            "manifest_url": self.manifest_url,
            "subtitles": subtitles,
        }

        if self.session_id is not None:
            session["session_id"] = self.session_id

        if log_file is not None:
            session["log_file"] = log_file
        if origin:
            session["origin"] = origin
        if updated_at:
            session["updated_at"] = updated_at
        return session


class TranscoderController:
    """Coordinate starting and stopping the FFmpeg-based transcoder."""

    def __init__(
        self,
        *,
        local_media_base: Optional[str] = None,
        publish_force_new_connection: bool = False,
        status_broadcaster: Optional[TranscoderStatusBroadcaster] = None,
        heartbeat_interval: int = 5,
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
        self._status_broadcaster = status_broadcaster
        self._heartbeat_interval = max(1, int(heartbeat_interval))
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._heartbeat_stop = threading.Event()
        self._current_session_id: Optional[str] = None
        self._session_history: List[str] = []
        self._session_retention = 2
        self._known_sessions: set[str] = set()

    def start(
        self,
        settings: EncoderSettings,
        publish_url: Optional[str] = None,
        force_new_connection: Optional[bool] = None,
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
            self._heartbeat_stop.clear()

        normalized_publish = publish_url.rstrip('/') + '/' if publish_url else None
        subtitle_tracks: List[Mapping[str, Any]] = []
        subtitle_assets: List[Path] = []
        session_id: Optional[str] = None
        retain_sessions: List[str] = []
        session_prefix: Optional[str] = None
        if session:
            raw_session_id = session.get("id")
            if raw_session_id is not None:
                session_id = str(raw_session_id)
            retain_value = session.get("retain")
            if isinstance(retain_value, (list, tuple, set)):
                retain_sessions = [str(entry) for entry in retain_value if str(entry)]
            prefix_value = session.get("segment_prefix")
            if prefix_value:
                session_prefix = str(prefix_value).strip("/")
        if session_id and not session_prefix:
            session_prefix = f"sessions/{session_id}"

        if session_id:
            LOGGER.info(
                "Transcoder session %s starting (retain=%s)",
                session_id,
                ",".join(retain_sessions) if retain_sessions else "none",
            )
            with self._lock:
                self._current_session_id = session_id
                self._register_session(session_id)
                for retained in retain_sessions:
                    self._known_sessions.add(retained)
        else:
            with self._lock:
                self._current_session_id = None

        self._prepare_session_directories(settings, session_id, retain_sessions, session_prefix)
        self._clear_root_dash_artifacts(settings.output_dir)
        if subtitle_metadata:
            try:
                subtitle_tracks, subtitle_assets = self._subtitle_service.collect_tracks(
                    rating_key=str(subtitle_metadata.get("rating_key") or "unknown"),
                    part_id=subtitle_metadata.get("part_id"),
                    input_path=settings.input_path,
                    output_dir=settings.output_dir,
                    publish_base_url=normalized_publish,
                    preferences=subtitle_metadata.get("preferences"),
                )
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning("Subtitle extraction failed: %s", exc)
        with self._lock:
            self._subtitle_tracks = list(subtitle_tracks)

        self._broadcast_status()

        def runner() -> None:
            pipeline: Optional[DashTranscodePipeline] = None
            try:
                if not normalized_publish:
                    raise ValueError("publish base URL is required for transcoder runs")
                encoder = FFmpegDashEncoder(settings)
                dash_opts = settings.dash
                manifest_delay = 0.0
                if dash_opts and dash_opts.availability_time_offset:
                    if not encoder.dash_supports_option("-availability_time_offset"):
                        LOGGER.debug(
                            "FFmpeg '%s' lacks -availability_time_offset; manifest publisher will inject availabilityTimeOffset=%s",
                            settings.ffmpeg_binary,
                            dash_opts.availability_time_offset,
                        )
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
                    manifest_publish_delay=manifest_delay,
                )
                pipeline = DashTranscodePipeline(
                    encoder,
                    publisher=publisher,
                    session_prefix=session_prefix,
                )
                handle = pipeline.start_live(static_assets=subtitle_assets)
                with self._lock:
                    self._handle = handle
                    self._latest_settings = settings
                    self._state = "running"
                    self._publish_url = normalized_publish
                    self._pipeline = pipeline
                    self._subtitle_tracks = list(subtitle_tracks)
                LOGGER.info("Started transcoder process (pid=%s)", handle.process.pid)
                self._broadcast_status()
                handle.wait()
                LOGGER.info("Transcoder exited with %s", handle.process.returncode)
            except Exception as exc:  # pragma: no cover - defensive, relies on FFmpeg
                LOGGER.exception("Transcoder run failed")
                with self._lock:
                    self._last_error = str(exc)
                    self._state = "error"
                self._broadcast_status()
            finally:
                self._cleanup_pipeline_output(pipeline, context="post-run")
                with self._lock:
                    self._handle = None
                    self._thread = None
                    self._publish_url = None
                    self._pipeline = None
                    if session_id and self._current_session_id == session_id:
                        self._current_session_id = None
                    if self._state != "error":
                        self._state = "idle"
                self._stop_heartbeat()
                self._broadcast_status()

        thread = threading.Thread(target=runner, name="transcoder-runner", daemon=True)
        with self._lock:
            self._thread = thread
        thread.start()
        self._start_heartbeat()
        self._broadcast_status()
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
        self._broadcast_status()

        process = handle.process
        try:
            LOGGER.info("Sending SIGINT to transcoder (pid=%s)", process.pid)
            process.send_signal(signal.SIGINT)
        except Exception as exc:  # pragma: no cover - system dependent
            LOGGER.exception("Failed to signal transcoder process: %s", exc)

        graceful_timeout = 5.0
        terminate_timeout = 5.0
        kill_timeout = 2.0

        def _wait_for_exit(timeout: float) -> Optional[int]:
            try:
                return process.wait(timeout=timeout)
            except TimeoutExpired:
                return None

        returncode = _wait_for_exit(graceful_timeout)
        if returncode is None and process.poll() is None:
            LOGGER.warning("Transcoder still running after SIGINT; sending SIGTERM")
            try:
                process.terminate()
            except Exception as exc:  # pragma: no cover - system dependent
                LOGGER.exception("Failed to terminate transcoder process: %s", exc)
            returncode = _wait_for_exit(terminate_timeout)

        if returncode is None and process.poll() is None:
            LOGGER.error("Transcoder ignored SIGTERM; sending SIGKILL")
            try:
                process.kill()
            except Exception as exc:  # pragma: no cover - system dependent
                LOGGER.exception("Failed to kill transcoder process: %s", exc)
            try:
                returncode = process.wait(timeout=kill_timeout)
            except TimeoutExpired:  # pragma: no cover - defensive
                LOGGER.error("Transcoder process still running after SIGKILL attempt")
                returncode = process.returncode

        if returncode is not None:
            LOGGER.info("Transcoder exited with %s", returncode)
        else:
            LOGGER.warning("Transcoder exit code unknown after stop sequence")

        if handle.publisher_thread:
            handle.publisher_thread.join(timeout=5)
        thread.join(timeout=5)

        self._cleanup_pipeline_output(pipeline, context="stop")

        with self._lock:
            self._handle = None
            self._thread = None
            self._pipeline = None
            if self._state != "error":
                self._state = "idle"
            self._current_session_id = None
        self._stop_heartbeat()
        self._broadcast_status()
        return True

    def status(self, local_base_override: Optional[str] = None) -> TranscoderStatus:
        """Return an immutable snapshot of controller state."""

        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            pid = self._handle.process.pid if self._handle else None
            settings = self._latest_settings
            manifest = str(settings.mpd_path) if settings else None
            output_dir = str(settings.output_dir) if settings else None
            current_session = self._current_session_id
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

        normalized_publish = publish_url.rstrip('/') + '/' if publish_url else None
        try:
            tracks, _ = self._subtitle_service.collect_tracks(
                rating_key=str(subtitle_metadata.get("rating_key") or "unknown"),
                part_id=subtitle_metadata.get("part_id"),
                input_path=settings.input_path,
                output_dir=settings.output_dir,
                publish_base_url=normalized_publish,
                preferences=subtitle_metadata.get("preferences"),
            )
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

    def _register_session(self, session_id: str) -> None:
        if not session_id:
            return
        if session_id in self._session_history:
            self._session_history.remove(session_id)
        self._session_history.append(session_id)
        self._known_sessions.add(session_id)
        max_history = max(1, self._session_retention)
        if len(self._session_history) > max_history:
            self._session_history = self._session_history[-max_history:]

    def _prepare_session_directories(
        self,
        settings: EncoderSettings,
        session_id: Optional[str],
        retain_sessions: Iterable[str],
        session_prefix: Optional[str],
    ) -> None:
        if not session_prefix:
            return
        base_dir = settings.output_dir.expanduser().resolve()
        prefix_path = Path(session_prefix.strip("/"))
        session_dir = (base_dir / prefix_path).expanduser().resolve()
        session_dir.mkdir(parents=True, exist_ok=True)

        preserve_ids = {str(entry) for entry in retain_sessions if str(entry)}
        if session_id:
            preserve_ids.add(session_id)
        preserve_ids.update(self._session_history[-self._session_retention:])

        self._prune_session_directories(base_dir, prefix_path, preserve_ids)

    def _prune_session_directories(
        self,
        base_dir: Path,
        prefix_path: Path,
        preserve_ids: Iterable[str],
    ) -> None:
        preserve = {str(entry) for entry in preserve_ids if str(entry)}
        if not prefix_path.parts:
            return
        if len(prefix_path.parts) == 1:
            sessions_root = base_dir
        else:
            sessions_root = base_dir.joinpath(*prefix_path.parts[:-1]).expanduser().resolve()
        if not sessions_root.exists() or not sessions_root.is_dir():
            return
        for child in sessions_root.iterdir():
            if not child.is_dir():
                continue
            session_name = child.name
            if session_name in preserve:
                continue
            if session_name not in self._known_sessions:
                continue
            try:
                shutil.rmtree(child)
                LOGGER.info("Removed stale session artifacts %s", child)
                with self._lock:
                    self._known_sessions.discard(session_name)
                    if session_name in self._session_history:
                        self._session_history.remove(session_name)
            except OSError as exc:
                LOGGER.warning("Failed to remove stale session directory %s: %s", child, exc)

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
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            return

        def _worker() -> None:
            while not self._heartbeat_stop.wait(self._heartbeat_interval):
                self._broadcast_status()

        self._heartbeat_stop.clear()
        thread = threading.Thread(
            target=_worker,
            name="transcoder-status-heartbeat",
            daemon=True,
        )
        self._heartbeat_thread = thread
        thread.start()

    def _stop_heartbeat(self) -> None:
        if not (self._heartbeat_thread and self._heartbeat_thread.is_alive()):
            self._heartbeat_stop.clear()
            self._heartbeat_thread = None
            return
        self._heartbeat_stop.set()
        self._heartbeat_thread.join(timeout=2.0)
        self._heartbeat_stop.clear()
        self._heartbeat_thread = None

    @staticmethod
    def _clear_root_dash_artifacts(output_dir: Path) -> None:
        try:
            resolved = output_dir.expanduser().resolve()
        except Exception:
            return
        patterns = ("chunk-*.m4s", "init-*.m4s")
        for pattern in patterns:
            for path in resolved.glob(pattern):
                if not path.is_file():
                    continue
                try:
                    path.unlink()
                    LOGGER.debug("Removed stale root DASH artifact %s", path)
                except OSError:
                    LOGGER.debug("Unable to remove root DASH artifact %s", path)


def _normalize_base_url(base: Optional[str]) -> Optional[str]:
    if not base:
        return None
    trimmed = base.strip()
    if not trimmed:
        return None
    return trimmed.rstrip('/') + '/'
