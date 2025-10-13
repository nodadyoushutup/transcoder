"""Build EncoderSettings from configuration + override payloads."""
from __future__ import annotations

from dataclasses import fields
from pathlib import Path
from typing import Any, Mapping

from transcoder import (
    AudioEncodingOptions,
    DashMuxingOptions,
    EncoderSettings,
    PackagerOptions,
    SubtitleEncodingOptions,
    VideoEncodingOptions,
)

from ..utils import (
    to_bool,
    to_optional_bool,
    to_optional_int,
    to_optional_str,
)

__all__ = ["build_encoder_settings"]


def _component_from_overrides(cls, override: Any) -> Any:
    if not isinstance(override, Mapping):
        return cls()
    valid = {field.name for field in fields(cls)}
    filtered: dict[str, Any] = {}
    for key, value in override.items():
        if key not in valid:
            continue
        if value is None:
            filtered[key] = None
            continue
        if isinstance(value, str) and value.strip() == "":
            filtered[key] = None
            continue
        if cls is DashMuxingOptions and key == "availability_time_offset":
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                continue
            filtered[key] = max(0.0, numeric)
            continue
        filtered[key] = value
    if not filtered:
        return cls()
    return cls(**filtered)


def build_encoder_settings(
    config: Mapping[str, Any],
    overrides: Mapping[str, Any],
) -> EncoderSettings:
    """Return EncoderSettings with configuration defaults applied."""

    input_path_value = overrides.get("input_path")
    if input_path_value:
        input_path = Path(str(input_path_value)).expanduser()
    else:
        input_path = Path(config["TRANSCODER_INPUT"]).expanduser()

    output_dir = Path(
        overrides.get("output_dir") or config["TRANSCODER_OUTPUT"]
    ).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    dash_source = overrides.get("dash")
    if dash_source is None:
        dash_source = overrides.get("muxing")

    dash_options = _component_from_overrides(DashMuxingOptions, dash_source)
    packager_options = _component_from_overrides(PackagerOptions, overrides.get("packager"))
    video_options = _component_from_overrides(VideoEncodingOptions, overrides.get("video"))
    audio_options = _component_from_overrides(AudioEncodingOptions, overrides.get("audio"))
    subtitle_options = _component_from_overrides(SubtitleEncodingOptions, overrides.get("subtitle"))

    output_basename = to_optional_str(overrides.get("output_basename")) or config.get("TRANSCODER_OUTPUT_BASENAME") or "audio_video"

    settings = EncoderSettings(
        input_path=str(input_path),
        output_dir=str(output_dir),
        output_basename=output_basename,
        video=video_options,
        audio=audio_options,
        subtitle=subtitle_options,
        dash=dash_options,
        packager=packager_options,
    )

    # Optional boolean toggles.
    if "realtime_input" in overrides:
        settings.realtime_input = to_bool(overrides.get("realtime_input"))
    if "copy_timestamps" in overrides:
        settings.copy_timestamps = to_bool(overrides.get("copy_timestamps"))
    if "start_at_zero" in overrides:
        settings.start_at_zero = to_bool(overrides.get("start_at_zero"))
    if "auto_keyframing" in overrides:
        auto_key = to_optional_bool(overrides.get("auto_keyframing"))
        if auto_key is not None:
            settings.auto_keyframing = auto_key

    # Track limits.
    max_video = to_optional_int(overrides.get("max_video_tracks"))
    if max_video is not None:
        settings.max_video_tracks = max_video
    max_audio = to_optional_int(overrides.get("max_audio_tracks"))
    if max_audio is not None:
        settings.max_audio_tracks = max_audio
    max_subtitle = to_optional_int(overrides.get("max_subtitle_tracks"))
    if max_subtitle is not None:
        settings.max_subtitle_tracks = max_subtitle

    # Session-specific metadata.
    session_info = overrides.get("session")
    if isinstance(session_info, Mapping):
        session_id = to_optional_str(session_info.get("id"))
        if session_id is not None:
            settings.session_id = session_id
        segment_prefix = to_optional_str(session_info.get("segment_prefix"))
        if segment_prefix is not None:
            settings.session_segment_prefix = segment_prefix.strip("/")

    manifest_target = overrides.get("manifest_target")
    if manifest_target is not None:
        settings.manifest_target = str(manifest_target)

    extra_output_args = overrides.get("extra_output_args")
    if isinstance(extra_output_args, (list, tuple)):
        settings.extra_output_args = tuple(str(arg) for arg in extra_output_args)

    input_args = overrides.get("input_args")
    if isinstance(input_args, (list, tuple)):
        settings.input_args = tuple(str(arg) for arg in input_args)

    timing_overrides = overrides.get("timing")
    if isinstance(timing_overrides, Mapping):
        settings.timing = dict(timing_overrides)

    layout_overrides = overrides.get("layout")
    if isinstance(layout_overrides, Mapping):
        settings.layout = dict(layout_overrides)

    return settings
