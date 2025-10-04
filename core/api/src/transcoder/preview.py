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

    publish_base = _normalize_base_url(_coerce_optional_str(merged.get("TRANSCODER_PUBLISH_BASE_URL")))
    native_put = _coerce_bool_flag(merged.get("TRANSCODER_PUBLISH_NATIVE_PUT"))
    force_new_conn = _coerce_bool_flag(merged.get("TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION"))

    if publish_base and native_put:
        manifest_name = f"{encoder_settings.output_basename}.mpd"
        encoder_settings.manifest_target = f"{publish_base}{manifest_name}"
        extra_args = list(encoder_settings.extra_output_args)
        if "-method" not in extra_args:
            extra_args.extend(["-method", "PUT"])
        encoder_settings.extra_output_args = tuple(extra_args)

    ffmpeg_args = encoder.build_command()
    display_args = [input_placeholder if arg == "pipe:" else arg for arg in ffmpeg_args]

    if publish_base:
        display_args = [f"TRANSCODER_PUBLISH_BASE_URL={publish_base}", *display_args]
        if native_put:
            display_args = ["TRANSCODER_PUBLISH_NATIVE_PUT=1", *display_args]
        if force_new_conn:
            display_args = ["TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION=1", *display_args]

    command = shlex.join(display_args)
    return {"argv": display_args, "command": command}


def _build_encoder_settings(values: Mapping[str, Any], app_config: Mapping[str, Any]) -> EncoderSettings:
    output_dir = Path(str(app_config.get("TRANSCODER_OUTPUT", "."))).expanduser()
    output_basename = str(app_config.get("TRANSCODER_OUTPUT_BASENAME", "stream"))

    video_options = _video_options(values)
    audio_options = _audio_options(values)
    dash_options = DashMuxingOptions()

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
    if scale_key == "1080p":
        filters: Tuple[str, ...] = ("scale=1920:-2",)
        options.filters = filters
    elif scale_key in {"", "720p"}:
        filters = ("scale=1280:-2",)
        options.filters = filters
    elif scale_key == "source":
        options.filters = tuple()
    else:
        filters = _parse_sequence(values.get("VIDEO_FILTERS"))
        if filters:
            options.filters = filters

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
