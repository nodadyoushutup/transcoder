"""Helpers for composing simulated FFmpeg commands for UI previews."""
from __future__ import annotations

import shlex
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from .config import (
    AudioEncodingOptions,
    DashMuxingOptions,
    EncoderSettings,
    SubtitleEncodingOptions,
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

    ffmpeg_args = encoder.build_command()
    display_args = [input_placeholder if arg == "pipe:" else arg for arg in ffmpeg_args]

    if publish_base:
        display_args = [f"TRANSCODER_PUBLISH_BASE_URL={publish_base}", *display_args]

    command = shlex.join(display_args)
    return {"argv": display_args, "command": command}


def _build_encoder_settings(values: Mapping[str, Any], app_config: Mapping[str, Any]) -> EncoderSettings:
    output_dir_value = _coerce_optional_str(values.get("TRANSCODER_LOCAL_OUTPUT_DIR"))
    if not output_dir_value:
        output_dir_value = str(app_config.get("TRANSCODER_OUTPUT", "."))
    output_dir = Path(output_dir_value).expanduser()
    output_basename = str(app_config.get("TRANSCODER_OUTPUT_BASENAME", "stream"))

    video_options = _video_options(values)
    audio_options = _audio_options(values)
    dash_options = _dash_options(values)
    subtitle_options = _subtitle_options(values)
    auto_keyframing = _coerce_optional_bool(values.get("TRANSCODER_AUTO_KEYFRAMING"))

    settings_kwargs: Dict[str, Any] = {
        "input_path": "pipe:",
        "output_dir": output_dir,
        "output_basename": output_basename,
        "realtime_input": True,
        "video": video_options,
        "audio": audio_options,
        "dash": dash_options,
        "subtitle": subtitle_options,
    }
    if auto_keyframing is not None:
        settings_kwargs["auto_keyframing"] = auto_keyframing

    settings = EncoderSettings(**settings_kwargs)
    copy_timestamps = _coerce_optional_bool(values.get("TRANSCODER_COPY_TIMESTAMPS"))
    if copy_timestamps is not None:
        settings.copy_timestamps = copy_timestamps

    start_at_zero = _coerce_optional_bool(values.get("TRANSCODER_START_AT_ZERO"))
    if start_at_zero is not None:
        settings.start_at_zero = start_at_zero

    realtime_input = _coerce_optional_bool(values.get("TRANSCODER_REALTIME_INPUT"))
    if realtime_input is not None:
        settings.realtime_input = realtime_input
    return settings


def _video_options(values: Mapping[str, Any]) -> VideoEncodingOptions:
    options = VideoEncodingOptions()

    codec = _coerce_optional_str(values.get("TRANSCODER_VIDEO_CODEC"))
    if codec:
        options.codec = codec

    bitrate = _coerce_optional_str(values.get("TRANSCODER_VIDEO_BITRATE"))
    if bitrate:
        options.bitrate = bitrate

    maxrate = _coerce_optional_str(values.get("TRANSCODER_VIDEO_MAXRATE"))
    if maxrate:
        options.maxrate = maxrate

    bufsize = _coerce_optional_str(values.get("TRANSCODER_VIDEO_BUFSIZE"))
    if bufsize:
        options.bufsize = bufsize

    preset = _coerce_optional_str(values.get("TRANSCODER_VIDEO_PRESET"))
    if preset:
        options.preset = preset

    sc_threshold = _coerce_optional_int(values.get("TRANSCODER_VIDEO_SC_THRESHOLD"))
    if sc_threshold is not None:
        options.sc_threshold = sc_threshold

    scene_cut = _coerce_optional_int(values.get("TRANSCODER_VIDEO_SCENECUT"))
    if scene_cut is not None:
        options.scene_cut = scene_cut

    return options


def _audio_options(values: Mapping[str, Any]) -> AudioEncodingOptions:
    options = AudioEncodingOptions()

    codec = _coerce_optional_str(values.get("TRANSCODER_AUDIO_CODEC"))
    if codec:
        options.codec = codec

    bitrate = _coerce_optional_str(values.get("TRANSCODER_AUDIO_BITRATE"))
    if bitrate is not None:
        options.bitrate = bitrate

    channels = _coerce_optional_int(values.get("TRANSCODER_AUDIO_CHANNELS"))
    if channels is not None and channels > 0:
        options.channels = channels

    return options


def _subtitle_options(values: Mapping[str, Any]) -> SubtitleEncodingOptions:
    options = SubtitleEncodingOptions()

    preferred = _coerce_optional_str(values.get("SUBTITLE_PREFERRED_LANGUAGE"))
    if preferred:
        options.preferred_language = preferred.strip().lower()

    include_forced = _coerce_optional_bool(values.get("SUBTITLE_INCLUDE_FORCED"))
    if include_forced is not None:
        options.include_forced = include_forced

    include_commentary = _coerce_optional_bool(values.get("SUBTITLE_INCLUDE_COMMENTARY"))
    if include_commentary is not None:
        options.include_commentary = include_commentary

    include_sdh = _coerce_optional_bool(values.get("SUBTITLE_INCLUDE_SDH"))
    if include_sdh is not None:
        options.include_sdh = include_sdh

    filters_raw = _coerce_optional_str(values.get("SUBTITLE_FILTERS"))
    if filters_raw:
        candidates = [entry.strip() for entry in filters_raw.replace(",", "\n").splitlines()]
        options.filters = tuple(filter(None, candidates))

    return options


def _dash_options(values: Mapping[str, Any]) -> DashMuxingOptions:
    options = DashMuxingOptions()

    segment_duration = _coerce_optional_float(values.get("TRANSCODER_SEGMENT_DURATION_SECONDS"))
    if segment_duration is not None and segment_duration > 0:
        options.segment_duration = segment_duration
        options.fragment_duration = segment_duration

    return options


def _coerce_frame_rate(value: Optional[str]) -> Optional[Tuple[int, int]]:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed or trimmed.lower() == "source":
        return None
    try:
        if "/" in trimmed:
            numerator_str, denominator_str = trimmed.split("/", 1)
            numerator = int(numerator_str)
            denominator = int(denominator_str)
        else:
            fraction = Fraction(trimmed).limit_denominator(100000)
            numerator = fraction.numerator
            denominator = fraction.denominator
    except (ValueError, ZeroDivisionError):
        return None
    if numerator <= 0 or denominator <= 0:
        return None
    return numerator, denominator


def _simulated_tracks(settings: EncoderSettings) -> Sequence[MediaTrack]:
    video_count = _track_budget(settings.max_video_tracks)
    audio_count = _track_budget(settings.max_audio_tracks)
    subtitle_count = _track_budget(settings.max_subtitle_tracks)

    tracks: list[MediaTrack] = []
    simulated_frame_rate = _coerce_frame_rate(settings.video.frame_rate) or (30000, 1001)
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
                frame_rate=simulated_frame_rate,
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

    if subtitle_count <= 0 and settings.subtitle:
        subtitle_count = 1

    for index in range(subtitle_count):
        tracks.append(
            MediaTrack(
                media_type=MediaType.SUBTITLE,
                source_index=index,
                relative_index=index,
                codec_name=settings.subtitle.codec,
                language=settings.subtitle.preferred_language,
                title=None,
                channels=None,
                sample_rate=None,
                bitrate=None,
                forced=False,
                hearing_impaired=settings.subtitle.include_sdh,
                commentary=settings.subtitle.include_commentary,
                default=index == 0,
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



def _coerce_optional_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
        if lowered == "":
            return None
    return None


__all__ = ["compose_preview_command", "DEFAULT_INPUT_PLACEHOLDER"]
