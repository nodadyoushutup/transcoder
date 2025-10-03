"""Configuration objects for the DASH transcoder."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence


@dataclass(slots=True)
class VideoEncodingOptions:
    """Settings for how video streams should be encoded."""

    codec: str = "libx264"
    bitrate: Optional[str] = "5M"
    maxrate: Optional[str] = "5M"
    bufsize: Optional[str] = "10M"
    preset: Optional[str] = "ultra"
    profile: Optional[str] = None
    tune: Optional[str] = None
    gop_size: Optional[int] = 48
    keyint_min: Optional[int] = 48
    sc_threshold: Optional[int] = 0
    vsync: Optional[str] = "1"
    filters: Sequence[str] = field(default_factory=lambda: ("scale=1280:-2",))
    extra_args: Sequence[str] = field(default_factory=tuple)


@dataclass(slots=True)
class AudioEncodingOptions:
    """Settings for how audio streams should be encoded."""

    codec: str = "aac"
    bitrate: Optional[str] = "192k"
    channels: Optional[int] = 2
    sample_rate: Optional[int] = 48_000
    profile: Optional[str] = "aac_low"
    filters: Sequence[str] = field(
        default_factory=lambda: ("aresample=async=1:first_pts=0",))
    extra_args: Sequence[str] = field(default_factory=tuple)


@dataclass(slots=True)
class DashMuxingOptions:
    """Settings that control the DASH muxing behavior."""

    segment_duration: float = 2.0
    fragment_duration: Optional[float] = 2.0
    min_segment_duration: Optional[int] = 2_000_000
    window_size: int = 10
    extra_window_size: int = 5
    retention_segments: Optional[int] = None
    streaming: bool = True
    remove_at_exit: bool = False
    extra_args: Sequence[str] = field(default_factory=tuple)
    use_timeline: bool = True
    use_template: bool = True
    http_user_agent: Optional[str] = None
    mux_preload: Optional[float] = 0.0
    mux_delay: Optional[float] = 0.0
    init_segment_name: Optional[str] = "init-$RepresentationID$.m4s"
    media_segment_name: Optional[str] = "chunk-$RepresentationID$-$Number%05d$.m4s"
    adaptation_sets: Optional[str] = None


@dataclass(slots=True)
class EncoderSettings:
    """High level configuration for the FFmpeg DASH encoder."""

    input_path: str | Path
    output_dir: Path
    output_basename: str = "stream"
    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    overwrite: bool = True
    realtime_input: bool = False
    video: VideoEncodingOptions = field(default_factory=VideoEncodingOptions)
    audio: AudioEncodingOptions = field(default_factory=AudioEncodingOptions)
    input_args: Sequence[str] = field(default_factory=lambda: (
        "-copyts", "-start_at_zero", "-fflags", "+genpts"))
    extra_output_args: Sequence[str] = field(default_factory=tuple)
    dash: DashMuxingOptions = field(default_factory=DashMuxingOptions)
    max_video_tracks: Optional[int] = 1
    max_audio_tracks: Optional[int] = 1

    def __post_init__(self) -> None:
        raw_input = str(self.input_path)
        if '://' in raw_input or raw_input in {'-', 'pipe:'}:
            self.input_path = raw_input
        else:
            resolved = Path(raw_input).expanduser().resolve()
            if not resolved.exists():
                raise FileNotFoundError(
                    f'Input path does not exist: {resolved}')
            self.input_path = resolved
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        if self.max_video_tracks is not None:
            self.max_video_tracks = max(0, int(self.max_video_tracks))
        if self.max_audio_tracks is not None:
            self.max_audio_tracks = max(0, int(self.max_audio_tracks))

    @property
    def mpd_path(self) -> Path:
        """Return the path to the manifest that FFmpeg will generate."""

        return self.output_dir / f"{self.output_basename}.mpd"
