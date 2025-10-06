"""FFmpeg-based DASH encoder orchestration."""
from __future__ import annotations

import logging
import shlex
import subprocess
from functools import lru_cache
from typing import Dict, List, Optional

from .config import EncoderSettings
from .exceptions import FFmpegExecutionError
from .tracks import MediaTrack, MediaType, probe_media_tracks

LOGGER = logging.getLogger(__name__)
_WARNED_DASH_OPTIONS: set[tuple[str, str]] = set()


@lru_cache(maxsize=32)
def _dash_supports_option(ffmpeg_binary: str, option: str) -> bool:
    """Return True if the dash muxer advertises support for ``option``."""

    try:
        result = subprocess.run(
            [ffmpeg_binary, "-hide_banner", "-h", "muxer=dash"],
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError:
        LOGGER.warning(
            "Unable to probe dash options; FFmpeg binary '%s' not found", ffmpeg_binary
        )
        return False

    output = f"{result.stdout}\n{result.stderr}"
    return option in output


class FFmpegDashEncoder:
    """Build and launch FFmpeg processes that produce DASH outputs."""

    def __init__(self, settings: EncoderSettings) -> None:
        self.settings = settings
        self._tracks: List[MediaTrack] = []
        self.refresh_tracks()

    @property
    def tracks(self) -> List[MediaTrack]:
        """Expose a copy of the discovered tracks."""

        return list(self._tracks)

    def refresh_tracks(self) -> None:
        """Re-run ffprobe discovery."""

        LOGGER.debug("Probing media tracks for %s", self.settings.input_path)
        self._tracks = probe_media_tracks(self.settings.input_path, self.settings.ffprobe_binary)

    def dash_supports_option(self, option: str) -> bool:
        """Return whether the linked FFmpeg binary advertises a DASH option."""

        return _dash_supports_option(self.settings.ffmpeg_binary, option)

    def build_command(self) -> List[str]:
        """Construct the FFmpeg CLI command for the configured DASH job."""

        settings = self.settings
        cmd: List[str] = [settings.ffmpeg_binary]

        if settings.realtime_input:
            cmd.append("-re")

        if settings.input_args:
            cmd.extend(str(arg) for arg in settings.input_args)
        cmd.extend(["-i", str(settings.input_path)])

        video_tracks = [track for track in self._tracks if track.media_type is MediaType.VIDEO]
        audio_tracks = [track for track in self._tracks if track.media_type is MediaType.AUDIO]

        if settings.max_video_tracks is not None:
            video_tracks = video_tracks[: settings.max_video_tracks]
        if settings.max_audio_tracks is not None:
            audio_tracks = audio_tracks[: settings.max_audio_tracks]

        stream_indices: Dict[str, List[int]] = {"v": [], "a": []}
        output_stream_index = 0

        for index, track in enumerate(video_tracks):
            cmd.extend(["-map", track.selector()])
            cmd.extend(self._build_video_args(index))
            stream_indices["v"].append(output_stream_index)
            output_stream_index += 1

        for index, track in enumerate(audio_tracks):
            cmd.extend(["-map", track.selector()])
            cmd.extend(self._build_audio_args(index, track))
            stream_indices["a"].append(output_stream_index)
            output_stream_index += 1

        if not stream_indices["v"] and not stream_indices["a"]:
            raise RuntimeError("No audio or video tracks available for DASH output.")

        cmd.extend(self._build_dash_args(stream_indices))
        if settings.extra_output_args:
            cmd.extend(str(arg) for arg in settings.extra_output_args)
        cmd.append(settings.output_target)
        return cmd

    def start(self, *, capture_output: bool = False) -> subprocess.Popen[str]:
        """Launch the FFmpeg process and return the running handle."""

        self.settings.output_dir.mkdir(parents=True, exist_ok=True)
        command = self.build_command()
        LOGGER.info("Starting FFmpeg: %s", shlex.join(command))
        stdout_opt = subprocess.PIPE if capture_output else None
        stderr_opt = subprocess.PIPE if capture_output else None
        process = subprocess.Popen(command, stdout=stdout_opt, stderr=stderr_opt, text=True)
        return process

    def run_to_completion(self, *, check: bool = True) -> subprocess.CompletedProcess[str]:
        """Run FFmpeg and wait for it to finish (mainly useful for VOD testing)."""

        self.settings.output_dir.mkdir(parents=True, exist_ok=True)
        command = self.build_command()
        LOGGER.info("Running FFmpeg: %s", shlex.join(command))
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        if check and result.returncode != 0:
            raise FFmpegExecutionError(
                f"FFmpeg exited with {result.returncode}: {result.stderr.strip()}"
            )
        return result

    def is_track_supported(self, track: MediaTrack) -> bool:
        """Return whether the encoder can handle the provided track."""

        return track.media_type in (MediaType.VIDEO, MediaType.AUDIO)

    def dry_run(self) -> str:
        """Return a shell-escaped command string without executing it."""

        return shlex.join(self.build_command())

    def _build_video_args(self, index: int) -> List[str]:
        opts = self.settings.video
        args: List[str] = [f"-c:v:{index}", opts.codec]
        if opts.bitrate:
            args.extend([f"-b:v:{index}", opts.bitrate])
        if opts.maxrate:
            args.extend([f"-maxrate:v:{index}", opts.maxrate])
        if opts.bufsize:
            args.extend([f"-bufsize:v:{index}", opts.bufsize])
        if opts.preset:
            args.extend([f"-preset:v:{index}", opts.preset])
        if opts.profile:
            args.extend([f"-profile:v:{index}", opts.profile])
        if opts.tune:
            args.extend([f"-tune:v:{index}", opts.tune])
        if opts.gop_size is not None:
            args.extend([f"-g:v:{index}", str(opts.gop_size)])
        if opts.keyint_min is not None:
            args.extend([f"-keyint_min:v:{index}", str(opts.keyint_min)])
        if opts.sc_threshold is not None:
            args.extend([f"-sc_threshold:v:{index}", str(opts.sc_threshold)])
        if opts.filters:
            filter_chain = ",".join(opts.filters)
            args.extend([f"-filter:v:{index}", filter_chain])
        if opts.frame_rate:
            args.extend([f"-r:v:{index}", str(opts.frame_rate)])
        if opts.vsync is not None and index == 0:
            args.extend(["-vsync", str(opts.vsync)])
        args.extend(opts.extra_args)
        return args

    def _build_audio_args(self, index: int, track: MediaTrack) -> List[str]:
        opts = self.settings.audio
        args: List[str] = [f"-c:a:{index}", opts.codec]
        if opts.bitrate:
            args.extend([f"-b:a:{index}", opts.bitrate])
        if opts.channels or track.channels:
            args.extend([f"-ac:a:{index}", str(opts.channels or track.channels)])
        if opts.sample_rate or track.sample_rate:
            args.extend([f"-ar:a:{index}", str(opts.sample_rate or track.sample_rate)])
        if opts.profile:
            args.extend([f"-profile:a:{index}", opts.profile])
        if opts.filters:
            filter_chain = ",".join(opts.filters)
            args.extend([f"-filter:a:{index}", filter_chain])
        args.extend(opts.extra_args)
        return args

    def _build_dash_args(self, stream_indices: Dict[str, List[int]]) -> List[str]:
        dash_opts = self.settings.dash
        args: List[str] = ["-f", "dash"]
        if dash_opts.use_template:
            args.extend(["-use_template", "1"])
        if dash_opts.use_timeline:
            args.extend(["-use_timeline", "1"])
        args.extend(["-seg_duration", f"{dash_opts.segment_duration:.3f}"])
        if dash_opts.fragment_duration is not None:
            args.extend(["-frag_duration", f"{dash_opts.fragment_duration:.3f}"])
        if dash_opts.min_segment_duration is not None:
            args.extend(["-min_seg_duration", str(dash_opts.min_segment_duration)])
        args.extend(["-window_size", str(dash_opts.window_size)])
        if dash_opts.extra_window_size:
            args.extend(["-extra_window_size", str(dash_opts.extra_window_size)])

        if dash_opts.streaming:
            args.extend(["-streaming", "1"])
        if dash_opts.remove_at_exit:
            args.extend(["-remove_at_exit", "1"])

        init_name = dash_opts.init_segment_name or f"{self.settings.output_basename}_init_$RepresentationID$.$ext$"
        media_name = dash_opts.media_segment_name or f"{self.settings.output_basename}_chunk_$RepresentationID$_$Number%05d$.$ext$"
        args.extend(["-init_seg_name", init_name, "-media_seg_name", media_name])

        if dash_opts.mux_preload is not None:
            args.extend(["-muxpreload", f"{dash_opts.mux_preload:g}"])
        if dash_opts.mux_delay is not None:
            args.extend(["-muxdelay", f"{dash_opts.mux_delay:g}"])
        if dash_opts.availability_time_offset is not None:
            option = "-availability_time_offset"
            if _dash_supports_option(self.settings.ffmpeg_binary, option):
                args.extend([
                    option,
                    f"{dash_opts.availability_time_offset:g}",
                ])
            else:
                key = (self.settings.ffmpeg_binary, option)
                if key not in _WARNED_DASH_OPTIONS:
                    log_fn = LOGGER.warning
                    suffix = ""
                    if option == "-availability_time_offset":
                        log_fn = LOGGER.debug
                        suffix = "; manifest availabilityTimeOffset will be injected during publishing"
                    log_fn(
                        "Skipping unsupported dash option %s for FFmpeg binary '%s'%s",
                        option,
                        self.settings.ffmpeg_binary,
                        suffix,
                    )
                    _WARNED_DASH_OPTIONS.add(key)

        adaptation_sets = dash_opts.adaptation_sets or _build_adaptation_sets(stream_indices)
        if adaptation_sets:
            args.extend(["-adaptation_sets", adaptation_sets])

        if dash_opts.http_user_agent:
            args.extend(["-user_agent", dash_opts.http_user_agent])

        args.extend(dash_opts.extra_args)
        return args
def _format_stream_spec(indices: List[int]) -> str:
    return ",".join(str(index) for index in indices)

def _build_adaptation_sets(stream_indices: Dict[str, List[int]]) -> Optional[str]:
    """Compose the ffmpeg -adaptation_sets argument."""

    entries: List[str] = []
    next_id = 0
    for type_code in ("v", "a"):
        indices = stream_indices.get(type_code) or []
        if not indices:
            continue
        streams_spec = _format_stream_spec(indices)
        entries.append(f"id={next_id},streams={streams_spec}")
        next_id += 1
    if not entries:
        return None
    return " ".join(entries)
