"""Discovery and preference filtering for subtitle tracks."""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Mapping, Optional

from ...utils import to_bool

LOGGER = logging.getLogger(__name__)

LANGUAGE_SYNONYMS = {
    "en": ("en", "eng", "english", "en-us", "en-gb", "en_ca", "en-au", "en-nz"),
    "es": ("es", "spa", "spanish", "es-es", "es-mx", "es-419", "esp"),
    "fr": ("fr", "fra", "fre", "french", "fr-fr", "fr-ca"),
    "de": ("de", "deu", "ger", "german", "de-de"),
    "it": ("it", "ita", "italian"),
    "pt": ("pt", "por", "portuguese", "pt-br", "pt-pt"),
    "ru": ("ru", "rus", "russian"),
    "ja": ("ja", "jpn", "japanese"),
    "ko": ("ko", "kor", "korean"),
    "zh": (
        "zh",
        "chi",
        "zho",
        "cmn",
        "chinese",
        "mandarin",
        "cantonese",
        "zh-cn",
        "zh-hans",
        "zh-hant",
        "zh-tw",
    ),
}

LANGUAGE_CANONICAL: dict[str, str] = {}
for canonical, aliases in LANGUAGE_SYNONYMS.items():
    for alias in aliases:
        LANGUAGE_CANONICAL[alias.lower()] = canonical

COMMENTARY_PATTERN = re.compile(r"\b(commentary|commentaire|kommentar|comentario)\b", re.IGNORECASE)
SDH_PATTERN = re.compile(
    r"\b(sdh|hard\s*-?of\s*-?hearing|hard\s*of\s*hearing|hoh|hearing\s*impaired|closed\s*caption[s]?|cc)\b",
    re.IGNORECASE,
)
FORCED_PATTERN = re.compile(r"\b(forced|narrative|signs|songs)\b", re.IGNORECASE)


@dataclass(frozen=True)
class SubtitleCandidate:
    """Description of a discovered subtitle stream."""

    public_id: str
    codec: str
    language: Optional[str]
    label: Optional[str]
    default: bool
    forced: bool
    extractor: str  # "mkv" or "ffmpeg"
    mkv_track_id: Optional[int] = None
    ffmpeg_index: Optional[int] = None


@dataclass(frozen=True)
class SubtitlePreferences:
    """User-configured filtering instructions for subtitle extraction."""

    preferred_language: Optional[str]
    include_forced: bool = False
    include_commentary: bool = False
    include_sdh: bool = False

    @classmethod
    def from_mapping(cls, data: Mapping[str, object]) -> "SubtitlePreferences":
        if not isinstance(data, Mapping):
            return cls(preferred_language=None)

        preferred_language = _normalize_language_tag(data.get("preferred_language"))
        include_forced = to_bool(data.get("include_forced"))
        include_commentary = to_bool(data.get("include_commentary"))
        include_sdh = to_bool(data.get("include_sdh"))

        return cls(
            preferred_language=preferred_language,
            include_forced=include_forced,
            include_commentary=include_commentary,
            include_sdh=include_sdh,
        )

    def is_configured(self) -> bool:
        return bool(self.preferred_language)


def _normalize_language_tag(value: object) -> Optional[str]:
    if value is None:
        return None
    try:
        text = str(value).strip().lower()
    except Exception:  # pragma: no cover - defensive
        return None
    if not text:
        return None

    text = text.replace("_", "-")
    direct = LANGUAGE_CANONICAL.get(text)
    if direct:
        return direct

    for token in re.split(r"[^a-z0-9]+", text):
        if not token:
            continue
        normalized = LANGUAGE_CANONICAL.get(token)
        if normalized:
            return normalized
        if len(token) >= 3:
            normalized = LANGUAGE_CANONICAL.get(token[:3])
            if normalized:
                return normalized
        if len(token) >= 2:
            normalized = LANGUAGE_CANONICAL.get(token[:2])
            if normalized:
                return normalized
    return None


def _infer_candidate_language(candidate: SubtitleCandidate) -> Optional[str]:
    language = _normalize_language_tag(candidate.language)
    if language:
        return language
    return _normalize_language_tag(candidate.label)


def _candidate_descriptor(candidate: SubtitleCandidate) -> str:
    parts: list[str] = []
    if candidate.language:
        parts.append(str(candidate.language))
    if candidate.label:
        parts.append(str(candidate.label))
    descriptor = " ".join(parts)
    return descriptor.lower()


class SubtitleCatalog:
    """Probe container files and filter subtitle candidates."""

    MKV_TEXT_CODECS = {
        "S_TEXT/UTF8",
        "S_TEXT/ASCII",
        "S_TEXT/ASS",
        "S_TEXT/SSA",
        "S_TEXT/WEBVTT",
        "S_TEXT/USF",
    }
    MKV_IMAGE_CODECS = {
        "S_HDMV/PGS",
        "S_VOBSUB",
        "S_IMAGE/BMP",
    }
    FFMPEG_TEXT_CODECS = {
        "subrip",
        "ass",
        "ssa",
        "webvtt",
        "mov_text",
        "text",
        "sami",
    }

    def __init__(
        self,
        *,
        mkvmerge: Optional[str] = None,
        mkvextract: Optional[str] = None,
        ffprobe: Optional[str] = None,
    ) -> None:
        self._mkvmerge = mkvmerge or shutil.which("mkvmerge")
        self._mkvextract = mkvextract or shutil.which("mkvextract")
        self._ffprobe = ffprobe or shutil.which("ffprobe") or "ffprobe"

    def probe(self, media_path: Path) -> List[SubtitleCandidate]:
        suffix = media_path.suffix.lower()
        if suffix == ".mkv" and self._mkvmerge and self._mkvextract:
            return self._probe_with_mkvmerge(media_path)
        return self._probe_with_ffprobe(media_path)

    def filter_candidates(
        self,
        candidates: Iterable[SubtitleCandidate],
        preferences: SubtitlePreferences,
    ) -> List[SubtitleCandidate]:
        if not preferences.preferred_language:
            return list(candidates)

        language = preferences.preferred_language
        base: list[SubtitleCandidate] = []
        forced: list[SubtitleCandidate] = []
        commentary: list[SubtitleCandidate] = []
        sdh: list[SubtitleCandidate] = []

        for candidate in candidates:
            candidate_language = _infer_candidate_language(candidate)
            if candidate_language != language:
                continue

            descriptor = _candidate_descriptor(candidate)
            is_commentary = bool(COMMENTARY_PATTERN.search(descriptor))
            is_sdh = bool(SDH_PATTERN.search(descriptor))
            is_forced = bool(candidate.forced) or bool(FORCED_PATTERN.search(descriptor))

            if not (is_commentary or is_sdh or is_forced):
                base.append(candidate)
            if is_forced:
                forced.append(candidate)
            if is_commentary:
                commentary.append(candidate)
            if is_sdh:
                sdh.append(candidate)

        selected: list[SubtitleCandidate] = []
        seen: set[str] = set()

        def _add(candidate: SubtitleCandidate) -> None:
            if candidate.public_id in seen:
                return
            selected.append(candidate)
            seen.add(candidate.public_id)

        if base:
            _add(self.select_primary_track(base))

        if preferences.include_forced:
            for candidate in forced:
                _add(candidate)

        if preferences.include_commentary:
            for candidate in commentary:
                _add(candidate)

        if preferences.include_sdh:
            for candidate in sdh:
                _add(candidate)

        return selected

    @staticmethod
    def select_primary_track(candidates: Iterable[SubtitleCandidate]) -> SubtitleCandidate:
        for candidate in candidates:
            if candidate.default:
                return candidate
        return next(iter(candidates))

    def _probe_with_mkvmerge(self, media_path: Path) -> List[SubtitleCandidate]:
        cmd = [
            self._mkvmerge,
            "--identify",
            "--identification-format",
            "json",
            str(media_path),
        ]
        LOGGER.debug("Running mkvmerge probe: %s", cmd)
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        payload = json.loads(proc.stdout or "{}")
        tracks = payload.get("tracks", [])
        candidates: List[SubtitleCandidate] = []
        for track in tracks:
            if track.get("type") != "subtitles":
                continue
            codec_id = str(track.get("codec") or track.get("codec_id") or "").upper()
            if not codec_id or codec_id in self.MKV_IMAGE_CODECS:
                continue
            if codec_id not in self.MKV_TEXT_CODECS and not codec_id.startswith("S_TEXT/"):
                continue
            properties = track.get("properties") or {}
            language = properties.get("language_ietf") or properties.get("language")
            label = properties.get("track_name")
            default = bool(properties.get("default_track"))
            forced = bool(properties.get("forced_track"))
            track_id = int(track.get("id"))
            candidates.append(
                SubtitleCandidate(
                    public_id=f"mkv-{track_id}",
                    codec=codec_id,
                    language=language,
                    label=label,
                    default=default,
                    forced=forced,
                    extractor="mkv",
                    mkv_track_id=track_id,
                )
            )
        return candidates

    def _probe_with_ffprobe(self, media_path: Path) -> List[SubtitleCandidate]:
        cmd = [
            self._ffprobe,
            "-v",
            "error",
            "-select_streams",
            "s",
            "-show_entries",
            "stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced",
            "-of",
            "json",
            str(media_path),
        ]
        LOGGER.debug("Running ffprobe: %s", cmd)
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        payload = json.loads(proc.stdout or "{}")
        streams = payload.get("streams", [])
        candidates: List[SubtitleCandidate] = []
        subtitle_order = 0
        for stream in streams:
            codec_name = str(stream.get("codec_name") or "").lower()
            if codec_name not in self.FFMPEG_TEXT_CODECS:
                subtitle_order += 1
                continue
            tags = stream.get("tags") or {}
            disposition = stream.get("disposition") or {}
            language = tags.get("language")
            label = tags.get("title")
            default = bool(disposition.get("default"))
            forced = bool(disposition.get("forced"))
            candidates.append(
                SubtitleCandidate(
                    public_id=f"ffmpeg-{subtitle_order}",
                    codec=codec_name.upper(),
                    language=language,
                    label=label,
                    default=default,
                    forced=forced,
                    extractor="ffmpeg",
                    ffmpeg_index=subtitle_order,
                )
            )
            subtitle_order += 1
        return candidates


__all__ = [
    "SubtitleCatalog",
    "SubtitleCandidate",
    "SubtitlePreferences",
]
