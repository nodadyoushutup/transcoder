"""Helpers for composing simulated FFmpeg commands for UI previews."""
from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from .config import (
    AudioEncodingOptions,
    DashMuxingOptions,
    EncoderSettings,
    VideoEncodingOptions,
)
from .encoder import FFmpegDashEncoder
from .tracks import MediaTrack, MediaType

DEFAULT_INPUT_PLACEHOLDER = "{{SOURCE_MEDIA}}"
_DEFAULT_TRACK_LIMIT = 1


def compose_preview_command(
    *,
    defaults: Mapping[str, Any],
    overrides: Mapping[str, Any],
    app_config: Mapping[str, Any],
    input_placeholder: str = DEFAULT_INPUT_PLACEHOLDER,
) -> Dict[str, Any]:
    """Return a preview of the FFmpeg command for the provided settings."""

    merged = dict(defaults)
    merged.update(overrides)

    encoder_settings = _build_encoder_settings(merged, app_config)
    tracks = _simulated_tracks(encoder_settings)

    encoder = FFmpegDashEncoder.__new__(FFmpegDashEncoder)  # type: ignore[misc]
    encoder.settings = encoder_settings  # type: ignore[attr-defined]
    encoder._tracks = tracks  # type: ignore[attr-defined]

    override_publish = _coerce_optional_str(overrides.get("TRANSCODER_PUBLISH_BASE_URL"))
    default_publish = _coerce_optional_str(defaults.get("TRANSCODER_PUBLISH_BASE_URL"))
    publish_base = _normalize_base_url(override_publish or default_publish)
    if not publish_base:
        raise ValueError("TRANSCODER_PUBLISH_BASE_URL is required to compose the transcoder command preview")
    force_new_conn = _coerce_bool_flag(merged.get("TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION"))

    ffmpeg_args = encoder.build_command()
    display_args = [input_placeholder if arg == "pipe:" else arg for arg in ffmpeg_args]

    if publish_base:
        display_args = [f"TRANSCODER_PUBLISH_BASE_URL={publish_base}", *display_args]
        if force_new_conn:
            display_args = ["TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION=1", *display_args]

    command = shlex.join(display_args)
    return {"argv": display_args, "command": command}


def _build_encoder_settings(values: Mapping[str, Any], app_config: Mapping[str, Any]) -> EncoderSettings:
    output_dir = Path(str(app_config.get("TRANSCODER_OUTPUT", "."))).expanduser()
    output_basename = str(app_config.get("TRANSCODER_OUTPUT_BASENAME", "stream"))

    video_options = _video_options(values)
    audio_options = _audio_options(values)
    dash_options = _dash_options(values)

    settings = EncoderSettings(
        input_path="pipe:",
        output_dir=output_dir,
        output_basename=output_basename,
        realtime_input=True,
        video=video_options,
        audio=audio_options,
        dash=dash_options,
    )
    return settings


def _video_options(values: Mapping[str, Any]) -> VideoEncodingOptions:
    options = VideoEncodingOptions()

    codec = _coerce_optional_str(values.get("VIDEO_CODEC"))
    if codec:
        options.codec = codec

    for key, attr in (
        ("VIDEO_BITRATE", "bitrate"),
        ("VIDEO_MAXRATE", "maxrate"),
        ("VIDEO_BUFSIZE", "bufsize"),
        ("VIDEO_PRESET", "preset"),
        ("VIDEO_PROFILE", "profile"),
        ("VIDEO_TUNE", "tune"),
        ("VIDEO_VSYNC", "vsync"),
    ):
        value = _coerce_optional_str(values.get(key))
        if value is not None:
            setattr(options, attr, value)

    for key, attr in (
        ("VIDEO_GOP_SIZE", "gop_size"),
        ("VIDEO_KEYINT_MIN", "keyint_min"),
        ("VIDEO_SC_THRESHOLD", "sc_threshold"),
    ):
        value = _coerce_optional_int(values.get(key))
        if value is not None:
            setattr(options, attr, value)

    scale = _coerce_optional_str(values.get("VIDEO_SCALE"))
    scale_key = (scale or "").strip().lower()
    if scale_key == "4k":
        filters: Tuple[str, ...] = ("scale=3840:-2",)
        options.filters = filters
    elif scale_key == "1080p":
        filters: Tuple[str, ...] = ("scale=1920:-2",)
        options.filters = filters
    elif scale_key == "720p":
        filters = ("scale=1280:-2",)
        options.filters = filters
    elif scale_key in {"", "source"}:
        options.filters = tuple()
    else:
        filters = _parse_sequence(values.get("VIDEO_FILTERS"))
        if filters:
            options.filters = filters

    frame_rate = _coerce_optional_str(values.get("VIDEO_FPS"))
    if frame_rate is not None:
        if frame_rate.strip().lower() in {"", "source"}:
            options.frame_rate = None
        else:
            options.frame_rate = frame_rate

    extra_args = _parse_sequence(values.get("VIDEO_EXTRA_ARGS"))
    if extra_args:
        options.extra_args = extra_args

    return options


def _audio_options(values: Mapping[str, Any]) -> AudioEncodingOptions:
    options = AudioEncodingOptions()

    codec = _coerce_optional_str(values.get("AUDIO_CODEC"))
    if codec:
        options.codec = codec

    bitrate = _coerce_optional_str(values.get("AUDIO_BITRATE"))
    if bitrate is not None:
        options.bitrate = bitrate

    channels = _coerce_optional_int(values.get("AUDIO_CHANNELS"))
    if channels is not None:
        options.channels = channels

    sample_rate = _coerce_optional_int(values.get("AUDIO_SAMPLE_RATE"))
    if sample_rate is not None:
        options.sample_rate = sample_rate

    profile = _coerce_optional_str(values.get("AUDIO_PROFILE"))
    if profile is not None:
        options.profile = profile

    filters = _parse_sequence(values.get("AUDIO_FILTERS"))
    if filters:
        options.filters = filters

    extra_args = _parse_sequence(values.get("AUDIO_EXTRA_ARGS"))
    if extra_args:
        options.extra_args = extra_args

    return options


def _dash_options(values: Mapping[str, Any]) -> DashMuxingOptions:
    options = DashMuxingOptions()

    offset = _coerce_optional_float(values.get("DASH_AVAILABILITY_OFFSET"))
    if offset is not None:
        options.availability_time_offset = max(0.0, offset)

    window_size = _coerce_optional_int(values.get("DASH_WINDOW_SIZE"))
    if window_size is not None:
        options.window_size = max(1, window_size)

    extra_window = _coerce_optional_int(values.get("DASH_EXTRA_WINDOW_SIZE"))
    if extra_window is not None:
        options.extra_window_size = max(0, extra_window)

    segment_duration = _coerce_optional_float(values.get("DASH_SEGMENT_DURATION"))
    if segment_duration is not None and segment_duration >= 0.0:
        options.segment_duration = segment_duration

    fragment_duration = _coerce_optional_float(values.get("DASH_FRAGMENT_DURATION"))
    if fragment_duration is not None and fragment_duration >= 0.0:
        options.fragment_duration = fragment_duration

    min_segment_duration = _coerce_optional_int(values.get("DASH_MIN_SEGMENT_DURATION"))
    if min_segment_duration is not None and min_segment_duration >= 0:
        options.min_segment_duration = min_segment_duration

    retention_override = _coerce_optional_int(values.get("DASH_RETENTION_SEGMENTS"))
    if retention_override is not None and retention_override >= 0:
        options.retention_segments = retention_override

    streaming_flag = _coerce_bool_flag(values.get("DASH_STREAMING"))
    if streaming_flag is not None:
        options.streaming = streaming_flag

    remove_at_exit = _coerce_bool_flag(values.get("DASH_REMOVE_AT_EXIT"))
    if remove_at_exit is not None:
        options.remove_at_exit = remove_at_exit

    use_template = _coerce_bool_flag(values.get("DASH_USE_TEMPLATE"))
    if use_template is not None:
        options.use_template = use_template

    use_timeline = _coerce_bool_flag(values.get("DASH_USE_TIMELINE"))
    if use_timeline is not None:
        options.use_timeline = use_timeline

    http_user_agent = _coerce_optional_str(values.get("DASH_HTTP_USER_AGENT"))
    if http_user_agent is not None:
        options.http_user_agent = http_user_agent.strip() or None

    mux_preload = _coerce_optional_float(values.get("DASH_MUX_PRELOAD"))
    if mux_preload is not None and mux_preload >= 0.0:
        options.mux_preload = mux_preload

    mux_delay = _coerce_optional_float(values.get("DASH_MUX_DELAY"))
    if mux_delay is not None and mux_delay >= 0.0:
        options.mux_delay = mux_delay

    init_name = _coerce_optional_str(values.get("DASH_INIT_SEGMENT_NAME"))
    if init_name is not None:
        options.init_segment_name = init_name.strip() or options.init_segment_name

    media_name = _coerce_optional_str(values.get("DASH_MEDIA_SEGMENT_NAME"))
    if media_name is not None:
        options.media_segment_name = media_name.strip() or options.media_segment_name

    adaptation_sets = _coerce_optional_str(values.get("DASH_ADAPTATION_SETS"))
    if adaptation_sets is not None:
        options.adaptation_sets = adaptation_sets.strip() or None

    extra_args = _parse_sequence(values.get("DASH_EXTRA_ARGS"))
    if extra_args:
        options.extra_args = extra_args

    return options


def _simulated_tracks(settings: EncoderSettings) -> Sequence[MediaTrack]:
    video_count = _track_budget(settings.max_video_tracks)
    audio_count = _track_budget(settings.max_audio_tracks)

    tracks: list[MediaTrack] = []
    for index in range(video_count):
        tracks.append(
            MediaTrack(
                media_type=MediaType.VIDEO,
                source_index=index,
                relative_index=index,
                codec_name=None,
                language=None,
                title=None,
                channels=None,
                sample_rate=None,
                bitrate=None,
            )
        )

    for index in range(audio_count):
        tracks.append(
            MediaTrack(
                media_type=MediaType.AUDIO,
                source_index=index,
                relative_index=index,
                codec_name=None,
                language=None,
                title=None,
                channels=settings.audio.channels,
                sample_rate=settings.audio.sample_rate,
                bitrate=None,
            )
        )

    if not tracks:
        tracks.append(
            MediaTrack(
                media_type=MediaType.AUDIO,
                source_index=0,
                relative_index=0,
                codec_name=None,
                language=None,
                title=None,
                channels=settings.audio.channels,
                sample_rate=settings.audio.sample_rate,
                bitrate=None,
            )
        )

    return tracks


def _track_budget(limit: Optional[int]) -> int:
    if limit is None:
        return _DEFAULT_TRACK_LIMIT
    return max(0, min(limit, _DEFAULT_TRACK_LIMIT))


def _parse_sequence(value: Any) -> Tuple[str, ...]:
    if value is None:
        return tuple()
    if isinstance(value, (list, tuple, set)):
        return tuple(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, str):
        entries = []
        for segment in value.replace(",", "\n").splitlines():
            segment = segment.strip()
            if segment:
                entries.append(segment)
        return tuple(entries)
    text = str(value).strip()
    return (text,) if text else tuple()


def _coerce_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text if text != "" else None


def _coerce_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    try:
        text = str(value).strip()
    except Exception:
        return None
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _coerce_optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        text = str(value).strip()
    except Exception:
        return None
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _normalize_base_url(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed.rstrip('/') + '/'


def _coerce_bool_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off", ""}:
            return False
    return False


__all__ = ["compose_preview_command", "DEFAULT_INPUT_PLACEHOLDER"]
