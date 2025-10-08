"""Configuration objects for the DASH transcoder."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence, Tuple


@dataclass(slots=True)
class AutoKeyframeState:
    """Derived timing metadata produced when auto keyframing is active."""

    segment_frames: int
    frame_rate: Tuple[int, int]
    segment_seconds: float
    segment_duration_input: float
    force_keyframe_expr: str
    codec_params: Optional[str] = None


@dataclass(slots=True)
class VideoEncodingOptions:
    """Settings for how video streams should be encoded."""

    codec: Optional[str] = None
    bitrate: Optional[str] = None
    maxrate: Optional[str] = None
    bufsize: Optional[str] = None
    preset: Optional[str] = None
    profile: Optional[str] = None
    tune: Optional[str] = None
    gop_size: Optional[int] = None
    keyint_min: Optional[int] = None
    sc_threshold: Optional[int] = None
    scene_cut: Optional[int] = None
    vsync: Optional[str] = None
    frame_rate: Optional[str] = None
    filters: Sequence[str] = field(default_factory=tuple)
    extra_args: Sequence[str] = field(default_factory=tuple)


@dataclass(slots=True)
class AudioEncodingOptions:
    """Settings for how audio streams should be encoded."""

    codec: Optional[str] = None
    bitrate: Optional[str] = None
    channels: Optional[int] = None
    sample_rate: Optional[int] = None
    profile: Optional[str] = None
    filters: Sequence[str] = field(default_factory=tuple)
    extra_args: Sequence[str] = field(default_factory=tuple)


@dataclass(slots=True)
class DashMuxingOptions:
    """Settings that control the DASH muxing behavior.

    Defaults are chosen to match the live profile used by this project:
    - 2s segments/fragments
    - 60 segment core window + 60 extra (120s window) on startup
    - 180 segment retention (3 minutes) to provide a deeper DVR by default
    - SegmentTemplate + SegmentTimeline enabled
    - streaming mode enabled
    """

    segment_duration: Optional[float] = 2.0
    fragment_duration: Optional[float] = 2.0
    min_segment_duration: Optional[int] = None
    window_size: Optional[int] = 60
    extra_window_size: Optional[int] = 60
    retention_segments: Optional[int] = 180
    streaming: Optional[bool] = True
    remove_at_exit: Optional[bool] = None
    extra_args: Sequence[str] = field(default_factory=tuple)
    use_timeline: Optional[bool] = True
    use_template: Optional[bool] = True
    http_user_agent: Optional[str] = None
    mux_preload: Optional[float] = None
    mux_delay: Optional[float] = None
    availability_time_offset: Optional[float] = None
    init_segment_name: Optional[str] = None
    media_segment_name: Optional[str] = None
    adaptation_sets: Optional[str] = None


@dataclass(slots=True)
class EncoderSettings:
    """High level configuration for the FFmpeg DASH encoder."""

    input_path: str | Path
    output_dir: Path
    output_basename: str = "audio_video"
    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    overwrite: bool = True
    realtime_input: bool = True
    video: VideoEncodingOptions = field(default_factory=VideoEncodingOptions)
    audio: AudioEncodingOptions = field(default_factory=AudioEncodingOptions)
    copy_timestamps: bool = True
    start_at_zero: bool = True
    input_args: Sequence[str] = field(default_factory=lambda: (
        "-fflags", "+genpts"))
    extra_output_args: Sequence[str] = field(default_factory=tuple)
    dash: DashMuxingOptions = field(default_factory=DashMuxingOptions)
    max_video_tracks: Optional[int] = 1
    max_audio_tracks: Optional[int] = 1
    manifest_target: Optional[str] = None
    session_id: Optional[str] = None
    session_segment_prefix: Optional[str] = None
    auto_keyframing: bool = True
    auto_keyframe_state: Optional[AutoKeyframeState] = None

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
        self.copy_timestamps = bool(self.copy_timestamps)
        self.start_at_zero = bool(self.start_at_zero)
        self.auto_keyframing = bool(self.auto_keyframing)

    @property
    def mpd_path(self) -> Path:
        """Return the path to the manifest that FFmpeg will generate."""

        return self.output_dir / f"{self.output_basename}.mpd"

    @property
    def output_target(self) -> str:
        """Return the final target FFmpeg should write the manifest to."""

        if self.manifest_target:
            return str(self.manifest_target)
        return str(self.mpd_path)

    @property
    def session_output_dir(self) -> Path:
        if self.session_segment_prefix:
            return (self.output_dir / Path(self.session_segment_prefix)).expanduser().resolve()
        return self.output_dir
