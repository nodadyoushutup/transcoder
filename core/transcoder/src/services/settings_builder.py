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
    VideoEncodingOptions,
)

from ..utils import (
    to_bool,
    to_optional_bool,
    to_optional_float,
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

    muxing_options = _component_from_overrides(DashMuxingOptions, overrides.get("muxing"))
    packager_options = _component_from_overrides(PackagerOptions, overrides.get("packager"))
    video_options = _component_from_overrides(VideoEncodingOptions, overrides.get("video"))
    audio_options = _component_from_overrides(AudioEncodingOptions, overrides.get("audio"))

    settings = EncoderSettings(
        input_path=str(input_path),
        output_dir=str(output_dir),
        muxing=muxing_options,
        packager=packager_options,
        video=video_options,
        audio=audio_options,
        enable_dash=to_bool(overrides.get("enable_dash", True)),
        enable_hls=to_bool(overrides.get("enable_hls", False)),
        preview_only=to_bool(overrides.get("preview_only", False)),
        max_duration_seconds=to_optional_int(overrides.get("max_duration_seconds")),
        force_keyint=to_optional_bool(overrides.get("force_keyint")),
        time_shift_buffer_depth=to_optional_float(overrides.get("time_shift_buffer_depth")),
        availability_time_offset=to_optional_float(overrides.get("availability_time_offset")),
        segment_duration_seconds=to_optional_int(overrides.get("segment_duration_seconds")),
        playlist_prefix=to_optional_str(overrides.get("playlist_prefix")),
        manifest_basename=to_optional_str(overrides.get("manifest_basename")),
        initial_segment=to_optional_int(overrides.get("initial_segment")),
        static_preview=to_bool(overrides.get("static_preview", False)),
        preview_frames=to_optional_int(overrides.get("preview_frames")),
    )
    return settings
