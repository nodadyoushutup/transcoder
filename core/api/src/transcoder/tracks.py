"""Utilities for inspecting media streams and modeling tracks."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import ffmpeg  # type: ignore

from .exceptions import MediaProbeError


class MediaType(str, Enum):
    """Stream types that we care about for DASH outputs."""

    VIDEO = "video"
    AUDIO = "audio"

    @classmethod
    def from_codec_type(cls, codec_type: str) -> "MediaType":
        try:
            return cls(codec_type)
        except ValueError as exc:  # pragma: no cover - defensive
            raise MediaProbeError(f"Unsupported codec type: {codec_type}") from exc


@dataclass(slots=True)
class MediaTrack:
    """Description of a single media stream discovered via ffprobe."""

    media_type: MediaType
    source_index: int
    relative_index: int
    codec_name: Optional[str]
    language: Optional[str]
    title: Optional[str]
    channels: Optional[int]
    sample_rate: Optional[int]
    bitrate: Optional[int]
    frame_rate: Optional[Tuple[int, int]] = None

    def selector(self, input_index: int = 0) -> str:
        """Return the ffmpeg `-map` selector for this stream."""

        type_code = {
            MediaType.VIDEO: "v",
            MediaType.AUDIO: "a",
        }[self.media_type]
        return f"{input_index}:{type_code}:{self.relative_index}"


def _parse_int(value: Optional[str]) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except ValueError:  # pragma: no cover - depends on ffprobe output
        return None


def _extract_language(stream: Dict[str, object]) -> Optional[str]:
    tags = stream.get("tags")
    if isinstance(tags, dict):
        language = tags.get("language") or tags.get("LANGUAGE")
        if isinstance(language, str):
            return language
    return None


def _extract_title(stream: Dict[str, object]) -> Optional[str]:
    tags = stream.get("tags")
    if isinstance(tags, dict):
        title = tags.get("title") or tags.get("TITLE")
        if isinstance(title, str):
            return title
    return None


def _parse_rational(value: Optional[str]) -> Optional[Tuple[int, int]]:
    if not value or value in {"0", "0/0"}:
        return None
    if "/" in value:
        numerator_str, denominator_str = value.split("/", 1)
    else:
        numerator_str, denominator_str = value, "1"
    try:
        numerator = int(numerator_str)
        denominator = int(denominator_str)
    except ValueError:  # pragma: no cover - depends on ffprobe output
        return None
    if denominator == 0 or numerator <= 0:
        return None
    return numerator, denominator


def probe_media_tracks(input_path: str | Path, ffprobe_binary: str = "ffprobe") -> List[MediaTrack]:
    """Inspect the input media and return the relevant streams."""

    try:
        probe_result = ffmpeg.probe(str(input_path), cmd=ffprobe_binary)
    except ffmpeg.Error as exc:  # type: ignore[attr-defined]
        raise MediaProbeError(
            f"Failed to probe media source '{input_path}': {exc.stderr.decode(errors='ignore') if hasattr(exc, 'stderr') else exc}"
        ) from exc

    rel_indices = {media_type: 0 for media_type in MediaType}
    tracks: List[MediaTrack] = []

    for stream in probe_result.get("streams", []):
        codec_type = stream.get("codec_type")
        if not isinstance(codec_type, str):
            continue
        if codec_type not in {t.value for t in MediaType}:
            continue
        media_type = MediaType.from_codec_type(codec_type)
        relative_index = rel_indices[media_type]
        rel_indices[media_type] += 1

        track = MediaTrack(
            media_type=media_type,
            source_index=int(stream.get("index", relative_index)),
            relative_index=relative_index,
            codec_name=stream.get("codec_name") if isinstance(stream.get("codec_name"), str) else None,
            language=_extract_language(stream),
            title=_extract_title(stream),
            channels=_parse_int(stream.get("channels")) if media_type is MediaType.AUDIO else None,
            sample_rate=_parse_int(stream.get("sample_rate")) if media_type is MediaType.AUDIO else None,
            bitrate=_parse_int(stream.get("bit_rate")),
            frame_rate=None,
        )
        if media_type is MediaType.VIDEO:
            avg_frame_rate = stream.get("avg_frame_rate")
            r_frame_rate = stream.get("r_frame_rate")
            frame_rate = None
            if isinstance(avg_frame_rate, str):
                frame_rate = _parse_rational(avg_frame_rate)
            if frame_rate is None and isinstance(r_frame_rate, str):
                frame_rate = _parse_rational(r_frame_rate)
            track.frame_rate = frame_rate
        tracks.append(track)

    if not tracks:
        raise MediaProbeError(f"No DASH-compatible tracks found in {input_path}")

    return tracks
