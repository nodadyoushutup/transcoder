"""Shaka Packager based orchestration pipeline."""
from __future__ import annotations

import errno
import logging
import os
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

from .config import EncoderSettings, PackagerOptions
from .encoder import FFmpegDashEncoder
from .packager import PackagerJob, PackagerStream
from .tracks import MediaTrack, MediaType

LOGGER = logging.getLogger(__name__)


def _sanitize_language(language: Optional[str], default: Optional[str] = None) -> str:
    if language is None:
        language = default
    if not language:
        return "und"
    normalized = str(language).strip().lower()
    return normalized or "und"


@dataclass(slots=True)
class LiveEncodingHandle:
    """Wrap the FFmpeg and Shaka Packager processes for a live session."""

    process: subprocess.Popen[str]
    packager_process: Optional[subprocess.Popen[str]] = None
    cleanup_callbacks: Sequence[Callable[[], None]] = field(default_factory=tuple)

    def wait(self) -> int:
        """Wait for FFmpeg (and Packager) to exit, then run cleanup callbacks."""

        try:
            return self._wait_internal()
        finally:
            self.cleanup()

    def cleanup(self) -> None:
        """Run registered cleanup callbacks."""

        for callback in self.cleanup_callbacks:
            try:
                callback()
            except Exception:  # pragma: no cover - defensive
                LOGGER.debug("Cleanup callback failed", exc_info=True)

    def _wait_internal(self) -> int:
        ffmpeg_rc = self.process.wait()
        if self.packager_process is not None:
            try:
                self.packager_process.wait()
            except Exception:  # pragma: no cover - defensive
                LOGGER.debug("Packager wait interrupted", exc_info=True)
        return ffmpeg_rc


@dataclass(slots=True)
class _StreamBinding:
    track: MediaTrack
    pipe_path: Path
    ffmpeg_args: List[str]
    packager_stream: PackagerStream
    output_index: int


class DashTranscodePipeline:
    """Coordinate FFmpeg encoding and Shaka Packager segmentation."""

    def __init__(
        self,
        encoder: FFmpegDashEncoder,
        *,
        session_prefix: Optional[str] = None,
    ) -> None:
        self.encoder = encoder
        self.settings: EncoderSettings = encoder.settings
        self._packager_options: PackagerOptions = self.settings.packager
        prefix = session_prefix or self.settings.session_segment_prefix
        self._session_prefix = prefix.strip("/") if prefix else None
        if self._session_prefix:
            session_dir = (self.settings.output_dir / self._session_prefix).expanduser().resolve()
        else:
            session_dir = self.settings.output_dir.expanduser().resolve()
        self._output_root = session_dir
        self._pipes_dir = self._output_root / ".pipes"
        self._bindings: list[_StreamBinding] = []
        self._output_dirs: set[Path] = set()

    def start_live(
        self,
        poll_interval: Optional[float] = None,  # retained for compatibility
        static_assets: Optional[Iterable[Path]] = None,
    ) -> LiveEncodingHandle:
        """Start FFmpeg and Shaka Packager for a live session."""

        del poll_interval  # no longer required; kept for interface compatibility
        self._prepare_directories()
        video_tracks, audio_tracks = self._select_tracks()
        if not video_tracks and not audio_tracks:
            raise RuntimeError("No audio or video tracks available for packager pipeline")

        bindings = self._create_bindings(video_tracks, audio_tracks)
        self._bindings = bindings
        cleanup_callbacks: list[Callable[[], None]] = []

        for binding in bindings:
            self._create_pipe(binding.pipe_path)
            cleanup_callbacks.append(self._make_pipe_cleanup(binding.pipe_path))
            parent = binding.packager_stream.init_segment.parent
            parent.mkdir(parents=True, exist_ok=True)
            self._output_dirs.add(parent)

        manifest_path = self.settings.mpd_path
        cleanup_callbacks.append(self._make_file_cleanup(manifest_path))

        packager_job = self._build_packager_job(manifest_path, bindings)
        packager_process = packager_job.start()

        ffmpeg_cmd = self._build_ffmpeg_command(bindings)
        LOGGER.info("Starting FFmpeg: %s", shlex.join(ffmpeg_cmd))
        ffmpeg_process = subprocess.Popen(ffmpeg_cmd, text=True)

        if static_assets:
            self._record_static_assets(static_assets)

        return LiveEncodingHandle(
            process=ffmpeg_process,
            packager_process=packager_process,
            cleanup_callbacks=tuple(cleanup_callbacks),
        )

    def cleanup_output(self) -> list[Path]:
        """Remove packaged artifacts created during the last run."""

        removed: list[Path] = []
        manifest_path = self.settings.mpd_path
        if manifest_path.exists():
            try:
                manifest_path.unlink()
                removed.append(manifest_path)
            except OSError:
                LOGGER.debug("Failed to remove manifest %s", manifest_path, exc_info=True)

        for directory in sorted(self._output_dirs, key=lambda path: len(str(path)), reverse=True):
            if not directory.exists() or not directory.is_dir():
                continue
            for path in directory.rglob("*"):
                if path.is_file():
                    try:
                        path.unlink()
                        removed.append(path)
                    except OSError:
                        LOGGER.warning("Unable to remove %s", path)
            try:
                directory.rmdir()
            except OSError:
                LOGGER.debug("Directory %s not empty after cleanup", directory, exc_info=True)

        if self._pipes_dir.exists():
            for pipe in self._pipes_dir.iterdir():
                try:
                    pipe.unlink()
                except OSError:
                    LOGGER.debug("Failed to remove pipe %s", pipe, exc_info=True)
            try:
                self._pipes_dir.rmdir()
            except OSError:
                LOGGER.debug("Failed to remove pipe directory %s", self._pipes_dir, exc_info=True)
        return removed

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _prepare_directories(self) -> None:
        self._output_root.mkdir(parents=True, exist_ok=True)
        if self._pipes_dir.exists():
            for child in self._pipes_dir.iterdir():
                try:
                    child.unlink()
                except OSError:
                    LOGGER.debug("Unable to remove stale pipe %s", child, exc_info=True)
        else:
            self._pipes_dir.mkdir(parents=True, exist_ok=True)

    def _select_tracks(self) -> Tuple[List[MediaTrack], List[MediaTrack]]:
        self.encoder.refresh_tracks()
        video_tracks = [track for track in self.encoder.tracks if track.media_type is MediaType.VIDEO]
        audio_tracks = [track for track in self.encoder.tracks if track.media_type is MediaType.AUDIO]

        max_video = self.settings.max_video_tracks
        if max_video is not None:
            video_tracks = video_tracks[: max(0, int(max_video))]
        max_audio = self.settings.max_audio_tracks
        if max_audio is not None:
            audio_tracks = audio_tracks[: max(0, int(max_audio))]
        return video_tracks, audio_tracks

    def _create_bindings(
        self,
        video_tracks: Sequence[MediaTrack],
        audio_tracks: Sequence[MediaTrack],
    ) -> list[_StreamBinding]:
        bindings: list[_StreamBinding] = []
        for index, track in enumerate(video_tracks):
            bindings.append(self._build_video_binding(index, track))
        for index, track in enumerate(audio_tracks):
            bindings.append(self._build_audio_binding(index, track))
        return bindings

    def _build_video_binding(self, index: int, track: MediaTrack) -> _StreamBinding:
        pipe_path = self._pipes_dir / f"video_{index}.mp4"
        representation_dir = self._output_root / "video" / f"v{index:02d}"
        init_segment = representation_dir / "init.mp4"
        segment_template = str(representation_dir / "seg-$Number$.m4s")
        packager_stream = PackagerStream(
            input_path=pipe_path,
            stream="video",
            init_segment=init_segment,
            segment_template=segment_template,
        )
        ffmpeg_args = [
            "-f",
            "mp4",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            str(pipe_path),
        ]
        return _StreamBinding(
            track=track,
            pipe_path=pipe_path,
            ffmpeg_args=ffmpeg_args,
            packager_stream=packager_stream,
            output_index=index,
        )

    def _build_audio_binding(self, index: int, track: MediaTrack) -> _StreamBinding:
        pipe_path = self._pipes_dir / f"audio_{index}.mp4"
        language = _sanitize_language(track.language, self._packager_options.default_audio_language)
        representation_dir = self._output_root / "audio" / language
        if index > 0:
            representation_dir = representation_dir / f"a{index:02d}"
        init_segment = representation_dir / "init.mp4"
        segment_template = str(representation_dir / "seg-$Number$.m4s")
        packager_stream = PackagerStream(
            input_path=pipe_path,
            stream="audio",
            init_segment=init_segment,
            segment_template=segment_template,
            language=language,
        )
        ffmpeg_args = [
            "-f",
            "mp4",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            str(pipe_path),
        ]
        return _StreamBinding(
            track=track,
            pipe_path=pipe_path,
            ffmpeg_args=ffmpeg_args,
            packager_stream=packager_stream,
            output_index=index,
        )

    def _build_packager_job(
        self,
        manifest_path: Path,
        bindings: Sequence[_StreamBinding],
    ) -> PackagerJob:
        extra_args: list[str] = []
        extra_args.extend(str(arg) for arg in self._packager_options.args)
        extra_args.extend(str(arg) for arg in self._packager_options.extra_flags)
        job = PackagerJob(
            binary=self._packager_options.binary,
            mpd_output=manifest_path,
            streams=[binding.packager_stream for binding in bindings],
            segment_duration=self._resolve_segment_duration(),
            time_shift_buffer_depth=self._packager_options.time_shift_buffer_depth,
            preserved_segments_outside_live_window=self._packager_options.preserved_segments_outside_live_window,
            minimum_update_period=self._packager_options.minimum_update_period,
            min_buffer_time=self._packager_options.min_buffer_time,
            generate_hls=self._packager_options.generate_hls,
            hls_master_playlist=self._resolve_hls_playlist(),
            allow_approximate_segment_timeline=self._packager_options.allow_approximate_segment_timeline,
            extra_args=tuple(extra_args),
        )
        return job

    def _resolve_segment_duration(self) -> Optional[float]:
        dash_opts = self.settings.dash
        if dash_opts.segment_duration and dash_opts.segment_duration > 0:
            return dash_opts.segment_duration
        if self._packager_options.segment_duration and self._packager_options.segment_duration > 0:
            return self._packager_options.segment_duration
        return None

    def _resolve_hls_playlist(self) -> Optional[Path]:
        playlist = self._packager_options.hls_master_playlist
        if playlist is None:
            return None
        path = Path(playlist)
        if not path.is_absolute():
            return (self._output_root / path).expanduser().resolve()
        return path.expanduser().resolve()

    def _build_ffmpeg_command(self, bindings: Sequence[_StreamBinding]) -> list[str]:
        cmd: list[str] = [self.settings.ffmpeg_binary]
        # Always force overwrite so FFmpeg will write to the pre-created FIFO pipes.
        cmd.append("-y")
        if self.settings.realtime_input:
            cmd.append("-re")
        if self.settings.copy_timestamps:
            cmd.append("-copyts")
        if self.settings.start_at_zero:
            cmd.append("-start_at_zero")
        if self.settings.input_args:
            cmd.extend(str(arg) for arg in self.settings.input_args)
        cmd.extend(["-i", str(self.settings.input_path)])

        video_bindings = [binding for binding in bindings if binding.track.media_type is MediaType.VIDEO]
        audio_bindings = [binding for binding in bindings if binding.track.media_type is MediaType.AUDIO]

        for index, binding in enumerate(video_bindings):
            cmd.extend(["-map", binding.track.selector()])
            cmd.extend(self.encoder._build_video_args(index))
            cmd.extend(binding.ffmpeg_args)

        for index, binding in enumerate(audio_bindings):
            cmd.extend(["-map", binding.track.selector()])
            cmd.extend(self.encoder._build_audio_args(index, binding.track))
            cmd.extend(binding.ffmpeg_args)

        if not video_bindings and not audio_bindings:
            raise RuntimeError("No output bindings configured for FFmpeg")
        return cmd

    @staticmethod
    def _create_pipe(path: Path) -> None:
        try:
            os.mkfifo(path)
        except FileExistsError:
            LOGGER.debug("Pipe %s already exists; reusing", path)
        except OSError as exc:  # pragma: no cover - system dependent
            if exc.errno == errno.EEXIST:
                LOGGER.debug("Pipe %s already exists; reusing", path)
            else:
                raise

    @staticmethod
    def _make_pipe_cleanup(path: Path) -> Callable[[], None]:
        def _cleanup() -> None:
            try:
                if path.exists():
                    path.unlink()
            except OSError:  # pragma: no cover - filesystem variance
                LOGGER.debug("Failed to remove pipe %s", path, exc_info=True)

        return _cleanup

    @staticmethod
    def _make_file_cleanup(path: Path) -> Callable[[], None]:
        def _cleanup() -> None:
            try:
                if path.exists():
                    path.unlink()
            except OSError:  # pragma: no cover - filesystem variance
                LOGGER.debug("Failed to remove file %s", path, exc_info=True)

        return _cleanup

    @staticmethod
    def _record_static_assets(static_assets: Iterable[Path]) -> None:
        for asset in static_assets:
            LOGGER.debug("Static asset prepared: %s", asset)
