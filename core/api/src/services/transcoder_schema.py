"""Shared helpers for validating and deriving transcoder system settings."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple


TRANSCODER_NUMERIC_DEFAULTS: Dict[str, Any] = {
    "TRANSCODER_SEGMENT_DURATION_SECONDS": 2.0,
    "TRANSCODER_KEEP_SEGMENTS": 20,
    "TRANSCODER_SUGGESTED_DELAY_FACTOR": 5,
    "TRANSCODER_MINIMUM_UPDATE_PERIOD_SECONDS": None,
    "TRANSCODER_TIME_SHIFT_BUFFER_SECONDS": None,
    "TRANSCODER_CLEANUP_INTERVAL_SECONDS": 5.0,
    "TRANSCODER_AUDIO_CHANNELS": 2,
    "TRANSCODER_VIDEO_SC_THRESHOLD": 0,
    "TRANSCODER_VIDEO_SCENECUT": 0,
}

TRANSCODER_STRING_DEFAULTS: Dict[str, Any] = {
    "TRANSCODER_PUBLISH_BASE_URL": "",
    "TRANSCODER_LOCAL_OUTPUT_DIR": "",
    "TRANSCODER_VIDEO_CODEC": "libx264",
    "TRANSCODER_VIDEO_BITRATE": "5M",
    "TRANSCODER_VIDEO_MAXRATE": "5M",
    "TRANSCODER_VIDEO_BUFSIZE": "10M",
    "TRANSCODER_VIDEO_PRESET": "superfast",
    "TRANSCODER_AUDIO_CODEC": "aac",
    "TRANSCODER_AUDIO_BITRATE": "192k",
    "TRANSCODER_PACKAGER_BINARY": "packager",
    "TRANSCODER_MANIFEST_NAME": "manifest.mpd",
    "TRANSCODER_VIDEO_SEGMENT_TEMPLATE": "video_$Number$.m4s",
    "TRANSCODER_AUDIO_SEGMENT_TEMPLATE": "audio_$Number$.m4s",
    "TRANSCODER_SESSION_SUBDIR": "sessions",
}

TRANSCODER_BOOLEAN_DEFAULTS: Dict[str, Any] = {
    "TRANSCODER_AUTO_KEYFRAMING": True,
}

TRANSCODER_ALL_KEYS = (
    set(TRANSCODER_NUMERIC_DEFAULTS)
    | set(TRANSCODER_STRING_DEFAULTS)
    | set(TRANSCODER_BOOLEAN_DEFAULTS)
)


@dataclass(frozen=True)
class TranscoderSettingsBundle:
    """Normalized transcoder settings along with derived values."""

    stored: Dict[str, Any]
    effective: Dict[str, Any]
    derived: Dict[str, Any]


def build_default_transcoder_settings(
    *,
    publish_base_url: str,
    output_dir: str,
) -> Dict[str, Any]:
    defaults: Dict[str, Any] = {}
    defaults.update(TRANSCODER_STRING_DEFAULTS)
    defaults.update(TRANSCODER_NUMERIC_DEFAULTS)
    defaults.update(TRANSCODER_BOOLEAN_DEFAULTS)
    defaults["TRANSCODER_PUBLISH_BASE_URL"] = publish_base_url.strip()
    defaults["TRANSCODER_LOCAL_OUTPUT_DIR"] = output_dir.strip()
    return defaults


def sanitize_transcoder_settings(
    values: Mapping[str, Any],
    *,
    defaults: Optional[Mapping[str, Any]] = None,
) -> TranscoderSettingsBundle:
    baseline = dict(defaults or {})
    combined: Dict[str, Any] = {**baseline}
    for key, value in (values or {}).items():
        combined[key] = value

    combined.pop("values", None)

    stored: Dict[str, Any] = {}
    effective: Dict[str, Any] = {}

    publish_base = _coerce_url(combined.get("TRANSCODER_PUBLISH_BASE_URL"), fallback=baseline.get("TRANSCODER_PUBLISH_BASE_URL", ""))
    output_dir = _coerce_path(combined.get("TRANSCODER_LOCAL_OUTPUT_DIR"), fallback=baseline.get("TRANSCODER_LOCAL_OUTPUT_DIR", ""))
    stored["TRANSCODER_PUBLISH_BASE_URL"] = publish_base
    effective["TRANSCODER_PUBLISH_BASE_URL"] = publish_base
    stored["TRANSCODER_LOCAL_OUTPUT_DIR"] = output_dir
    effective["TRANSCODER_LOCAL_OUTPUT_DIR"] = output_dir

    segment_seconds = _coerce_positive_float(
        combined.get("TRANSCODER_SEGMENT_DURATION_SECONDS"),
        fallback=baseline.get("TRANSCODER_SEGMENT_DURATION_SECONDS", 2.0),
        minimum=0.1,
    )
    keep_segments = _coerce_positive_int(
        combined.get("TRANSCODER_KEEP_SEGMENTS"),
        fallback=baseline.get("TRANSCODER_KEEP_SEGMENTS", 20),
        minimum=1,
    )
    delay_factor = _coerce_positive_int(
        combined.get("TRANSCODER_SUGGESTED_DELAY_FACTOR"),
        fallback=baseline.get("TRANSCODER_SUGGESTED_DELAY_FACTOR", 5),
        minimum=1,
    )

    minimum_update_period = _coerce_optional_positive_float(
        combined.get("TRANSCODER_MINIMUM_UPDATE_PERIOD_SECONDS"),
        minimum=0.1,
    )
    time_shift_buffer = _coerce_optional_positive_float(
        combined.get("TRANSCODER_TIME_SHIFT_BUFFER_SECONDS"),
        minimum=0.1,
    )
    cleanup_interval = _coerce_positive_float(
        combined.get("TRANSCODER_CLEANUP_INTERVAL_SECONDS"),
        fallback=baseline.get("TRANSCODER_CLEANUP_INTERVAL_SECONDS", 5.0),
        minimum=0.5,
    )
    audio_channels = _coerce_positive_int(
        combined.get("TRANSCODER_AUDIO_CHANNELS"),
        fallback=baseline.get("TRANSCODER_AUDIO_CHANNELS", 2),
        minimum=1,
    )
    sc_threshold = _coerce_int(
        combined.get("TRANSCODER_VIDEO_SC_THRESHOLD"),
        fallback=baseline.get("TRANSCODER_VIDEO_SC_THRESHOLD", 0),
    )
    scene_cut = _coerce_int(
        combined.get("TRANSCODER_VIDEO_SCENECUT"),
        fallback=baseline.get("TRANSCODER_VIDEO_SCENECUT", 0),
    )

    auto_keyframing = _coerce_bool(
        combined.get("TRANSCODER_AUTO_KEYFRAMING"),
        fallback=bool(baseline.get("TRANSCODER_AUTO_KEYFRAMING", True)),
    )

    packager_binary = _coerce_string(
        combined.get("TRANSCODER_PACKAGER_BINARY"),
        fallback=baseline.get("TRANSCODER_PACKAGER_BINARY", "packager"),
    )
    manifest_name = _coerce_string(
        combined.get("TRANSCODER_MANIFEST_NAME"),
        fallback=baseline.get("TRANSCODER_MANIFEST_NAME", "manifest.mpd"),
    )
    session_subdir = _sanitize_session_subdir(
        combined.get("TRANSCODER_SESSION_SUBDIR"),
        fallback=baseline.get("TRANSCODER_SESSION_SUBDIR", "sessions"),
    )
    video_template = _coerce_template(
        combined.get("TRANSCODER_VIDEO_SEGMENT_TEMPLATE"),
        fallback=baseline.get("TRANSCODER_VIDEO_SEGMENT_TEMPLATE", "video_$Number$.m4s"),
    )
    audio_template = _coerce_template(
        combined.get("TRANSCODER_AUDIO_SEGMENT_TEMPLATE"),
        fallback=baseline.get("TRANSCODER_AUDIO_SEGMENT_TEMPLATE", "audio_$Number$.m4s"),
    )

    stored["TRANSCODER_SEGMENT_DURATION_SECONDS"] = segment_seconds
    stored["TRANSCODER_KEEP_SEGMENTS"] = keep_segments
    stored["TRANSCODER_SUGGESTED_DELAY_FACTOR"] = delay_factor
    stored["TRANSCODER_MINIMUM_UPDATE_PERIOD_SECONDS"] = minimum_update_period
    stored["TRANSCODER_TIME_SHIFT_BUFFER_SECONDS"] = time_shift_buffer
    stored["TRANSCODER_CLEANUP_INTERVAL_SECONDS"] = cleanup_interval
    stored["TRANSCODER_AUDIO_CHANNELS"] = audio_channels
    stored["TRANSCODER_VIDEO_SC_THRESHOLD"] = sc_threshold
    stored["TRANSCODER_VIDEO_SCENECUT"] = scene_cut
    stored["TRANSCODER_AUTO_KEYFRAMING"] = auto_keyframing
    stored["TRANSCODER_PACKAGER_BINARY"] = packager_binary
    stored["TRANSCODER_MANIFEST_NAME"] = manifest_name
    stored["TRANSCODER_SESSION_SUBDIR"] = session_subdir
    stored["TRANSCODER_VIDEO_SEGMENT_TEMPLATE"] = video_template
    stored["TRANSCODER_AUDIO_SEGMENT_TEMPLATE"] = audio_template

    effective_minimum_update = minimum_update_period or segment_seconds
    effective_time_shift = time_shift_buffer or (segment_seconds * keep_segments)
    derived_delay = max(segment_seconds, delay_factor * segment_seconds)
    fragment_duration_us = int(round(segment_seconds * 1_000_000))

    effective["TRANSCODER_SEGMENT_DURATION_SECONDS"] = segment_seconds
    effective["TRANSCODER_KEEP_SEGMENTS"] = keep_segments
    effective["TRANSCODER_SUGGESTED_DELAY_FACTOR"] = delay_factor
    effective["TRANSCODER_MINIMUM_UPDATE_PERIOD_SECONDS"] = effective_minimum_update
    effective["TRANSCODER_TIME_SHIFT_BUFFER_SECONDS"] = effective_time_shift
    effective["TRANSCODER_CLEANUP_INTERVAL_SECONDS"] = cleanup_interval
    effective["TRANSCODER_AUDIO_CHANNELS"] = audio_channels
    effective["TRANSCODER_VIDEO_SC_THRESHOLD"] = sc_threshold
    effective["TRANSCODER_VIDEO_SCENECUT"] = scene_cut
    effective["TRANSCODER_AUTO_KEYFRAMING"] = auto_keyframing
    effective["TRANSCODER_PACKAGER_BINARY"] = packager_binary
    effective["TRANSCODER_MANIFEST_NAME"] = manifest_name
    effective["TRANSCODER_SESSION_SUBDIR"] = session_subdir
    effective["TRANSCODER_VIDEO_SEGMENT_TEMPLATE"] = video_template
    effective["TRANSCODER_AUDIO_SEGMENT_TEMPLATE"] = audio_template

    for name, fallback in (
        ("TRANSCODER_VIDEO_CODEC", "libx264"),
        ("TRANSCODER_VIDEO_BITRATE", "5M"),
        ("TRANSCODER_VIDEO_MAXRATE", "5M"),
        ("TRANSCODER_VIDEO_BUFSIZE", "10M"),
        ("TRANSCODER_VIDEO_PRESET", "superfast"),
        ("TRANSCODER_AUDIO_CODEC", "aac"),
        ("TRANSCODER_AUDIO_BITRATE", "192k"),
    ):
        sanitized = _coerce_string(combined.get(name), fallback=baseline.get(name, fallback))
        stored[name] = sanitized
        effective[name] = sanitized

    derived: Dict[str, Any] = {
        "fragment_duration_us": fragment_duration_us,
        "suggested_presentation_delay_seconds": derived_delay,
        "force_keyframe_expression": f"expr:gte(t,n_forced*{segment_seconds:.9f})",
        "session_subdir": session_subdir,
    }

    return TranscoderSettingsBundle(stored=stored, effective=effective, derived=derived)


def _coerce_string(value: Any, *, fallback: str = "") -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return fallback.strip()
    return str(value).strip()


def _coerce_template(value: Any, *, fallback: str) -> str:
    candidate = _coerce_string(value, fallback=fallback)
    return candidate or fallback


def _sanitize_session_subdir(value: Any, *, fallback: str) -> str:
    candidate = _coerce_string(value, fallback=fallback)
    normalized = candidate.strip("/ ")
    return normalized or fallback


def _coerce_url(value: Any, *, fallback: str = "") -> str:
    text = _coerce_string(value, fallback=fallback)
    if not text:
        return ""
    return text


def _coerce_path(value: Any, *, fallback: str = "") -> str:
    text = _coerce_string(value, fallback=fallback)
    return text or fallback


def _coerce_positive_float(value: Any, *, fallback: float, minimum: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = float(fallback)
    if numeric < minimum:
        numeric = float(minimum)
    return numeric


def _coerce_optional_positive_float(value: Any, *, minimum: float) -> Optional[float]:
    if value in (None, "", "null"):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric < minimum:
        return None
    return numeric


def _coerce_positive_int(value: Any, *, fallback: Any, minimum: int) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        numeric = int(fallback)
    if numeric < minimum:
        numeric = minimum
    return numeric


def _coerce_int(value: Any, *, fallback: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(fallback)
        except (TypeError, ValueError):
            return 0


def _coerce_bool(value: Any, *, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return bool(fallback)


__all__ = [
    "TranscoderSettingsBundle",
    "build_default_transcoder_settings",
    "sanitize_transcoder_settings",
    "TRANSCODER_ALL_KEYS",
]
