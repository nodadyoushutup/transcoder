"""Inspect media files and convert text subtitle streams to WebVTT."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Mapping, Optional


LOGGER = logging.getLogger(__name__)


_SANITIZE_PATTERN = re.compile(r"[^A-Za-z0-9._-]")

_LANGUAGE_SYNONYMS = {
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

_LANGUAGE_CANONICAL: dict[str, str] = {}
for _canonical, _aliases in _LANGUAGE_SYNONYMS.items():
    for _alias in _aliases:
        _LANGUAGE_CANONICAL[_alias.lower()] = _canonical

_COMMENTARY_PATTERN = re.compile(r"\b(commentary|commentaire|kommentar|comentario)\b", re.IGNORECASE)
_SDH_PATTERN = re.compile(
    r"\b(sdh|hard\s*-?of\s*-?hearing|hard\s*of\s*hearing|hoh|hearing\s*impaired|closed\s*caption[s]?|cc)\b",
    re.IGNORECASE,
)
_FORCED_PATTERN = re.compile(r"\b(forced|narrative|signs|songs)\b", re.IGNORECASE)


def _sanitize_component(value: object) -> str:
    text = str(value) if value is not None else ""
    sanitized = _SANITIZE_PATTERN.sub("_", text)
    return sanitized or "track"


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
        include_forced = _coerce_pref_bool(data.get("include_forced"))
        include_commentary = _coerce_pref_bool(data.get("include_commentary"))
        include_sdh = _coerce_pref_bool(data.get("include_sdh"))

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
    direct = _LANGUAGE_CANONICAL.get(text)
    if direct:
        return direct

    for token in re.split(r"[^a-z0-9]+", text):
        if not token:
            continue
        normalized = _LANGUAGE_CANONICAL.get(token)
        if normalized:
            return normalized
        if len(token) >= 3:
            normalized = _LANGUAGE_CANONICAL.get(token[:3])
            if normalized:
                return normalized
        if len(token) >= 2:
            normalized = _LANGUAGE_CANONICAL.get(token[:2])
            if normalized:
                return normalized
    return None


def _coerce_pref_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off", ""}:
            return False
    return False


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


class SubtitleService:
    """Extract subtitle streams from container files and convert them to VTT."""

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
        ffmpeg: Optional[str] = None,
    ) -> None:
        self._mkvmerge = mkvmerge or shutil.which("mkvmerge")
        self._mkvextract = mkvextract or shutil.which("mkvextract")
        self._ffprobe = ffprobe or shutil.which("ffprobe") or "ffprobe"
        self._ffmpeg = ffmpeg or shutil.which("ffmpeg") or "ffmpeg"

    def collect_tracks(
        self,
        *,
        rating_key: str,
        part_id: Optional[str],
        input_path: str | Path,
        output_dir: Path,
        publish_base_url: Optional[str],
        preferences: Optional[Mapping[str, object]] = None,
    ) -> tuple[List[dict[str, object]], List[Path]]:
        media_path = Path(input_path).expanduser().resolve()
        if not media_path.exists():
            LOGGER.warning(
                "Subtitle scan skipped (rating=%s part=%s) — media path missing: %s",
                rating_key,
                part_id,
                media_path,
            )
            return [], []

        LOGGER.info(
            "Scanning subtitles (rating=%s part=%s path=%s)",
            rating_key,
            part_id,
            media_path,
        )

        try:
            candidates = self._probe_tracks(media_path)
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.warning(
                "Subtitle probe failed (rating=%s part=%s path=%s): %s",
                rating_key,
                part_id,
                media_path,
                exc,
            )
            return [], []

        if not candidates:
            LOGGER.info(
                "Subtitle probe found no text tracks (rating=%s part=%s path=%s)",
                rating_key,
                part_id,
                media_path,
            )
            return [], []

        LOGGER.info(
            "Subtitle probe discovered %d candidate(s) (rating=%s part=%s)",
            len(candidates),
            rating_key,
            part_id,
        )

        active_preferences = SubtitlePreferences.from_mapping(preferences) if preferences else None
        if active_preferences and active_preferences.is_configured():
            filtered = self._filter_candidates(candidates, active_preferences)
            LOGGER.info(
                "Subtitle preferences retained %d of %d candidate(s) (rating=%s part=%s lang=%s forced=%s commentary=%s sdh=%s)",
                len(filtered),
                len(candidates),
                rating_key,
                part_id,
                active_preferences.preferred_language,
                active_preferences.include_forced,
                active_preferences.include_commentary,
                active_preferences.include_sdh,
            )
            candidates = filtered
            if not candidates:
                LOGGER.info(
                    "No subtitle tracks matched the configured preferences (rating=%s part=%s)",
                    rating_key,
                    part_id,
                )
                return [], []

        normalized_rating = _sanitize_component(rating_key)
        normalized_part = _sanitize_component(part_id)
        target_root = (output_dir / "subtitles" / normalized_rating).expanduser().resolve()
        target_root.mkdir(parents=True, exist_ok=True)

        results: List[dict[str, object]] = []
        files: List[Path] = []

        for candidate in candidates:
            try:
                relative_name = f"{normalized_part}_{candidate.public_id}.vtt"
                destination = target_root / relative_name
                if not destination.exists() or destination.stat().st_size == 0:
                    if candidate.extractor == "mkv" and candidate.mkv_track_id is not None:
                        LOGGER.info(
                            "Extracting subtitle via mkvextract (rating=%s part=%s track=%s)",
                            rating_key,
                            part_id,
                            candidate.mkv_track_id,
                        )
                        self._extract_with_mkv(media_path, candidate.mkv_track_id, destination)
                    elif candidate.extractor == "ffmpeg" and candidate.ffmpeg_index is not None:
                        LOGGER.info(
                            "Extracting subtitle via ffmpeg (rating=%s part=%s index=%s)",
                            rating_key,
                            part_id,
                            candidate.ffmpeg_index,
                        )
                        self._extract_with_ffmpeg(media_path, candidate.ffmpeg_index, destination)
                    else:
                        raise RuntimeError("Unsupported subtitle candidate configuration")

                relative_path = Path("subtitles") / normalized_rating / destination.name
                url = self._compose_url(publish_base_url, relative_path.as_posix())
                results.append(
                    {
                        "id": candidate.public_id,
                        "language": candidate.language,
                        "label": candidate.label,
                        "codec": candidate.codec,
                        "forced": candidate.forced,
                        "default": candidate.default,
                        "path": relative_path.as_posix(),
                        "url": url,
                    }
                )
                files.append(destination)
            except Exception as exc:  # pragma: no cover - defensive
                LOGGER.warning(
                    "Failed to prepare subtitle track (rating=%s part=%s id=%s path=%s): %s",
                    rating_key,
                    part_id,
                    candidate.public_id,
                    media_path,
                    exc,
                )

        return results, files

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _probe_tracks(self, media_path: Path) -> List[SubtitleCandidate]:
        suffix = media_path.suffix.lower()
        if suffix == ".mkv" and self._mkvmerge and self._mkvextract:
            return self._probe_with_mkvmerge(media_path)
        return self._probe_with_ffprobe(media_path)

    def _filter_candidates(
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
            is_commentary = bool(_COMMENTARY_PATTERN.search(descriptor))
            is_sdh = bool(_SDH_PATTERN.search(descriptor))
            is_forced = bool(candidate.forced) or bool(_FORCED_PATTERN.search(descriptor))

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
            _add(self._select_primary_track(base))

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
    def _select_primary_track(candidates: Iterable[SubtitleCandidate]) -> SubtitleCandidate:
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

    def _extract_with_mkv(self, media_path: Path, track_id: int, destination: Path) -> None:
        if not self._mkvextract:
            raise RuntimeError("mkvextract not available")

        tmp_fd, extracted_path = tempfile.mkstemp(prefix="subtitle-", suffix=".raw")
        os.close(tmp_fd)
        extracted_file = Path(extracted_path)
        try:
            cmd = [self._mkvextract, "tracks", str(media_path), f"{track_id}:{extracted_file}"]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self._convert_to_vtt(extracted_file, destination)
        finally:
            if extracted_file.exists():
                extracted_file.unlink(missing_ok=True)

    def _extract_with_ffmpeg(self, media_path: Path, stream_index: int, destination: Path) -> None:
        tmp_fd, tmp_path = tempfile.mkstemp(prefix="subtitle-", suffix=".vtt")
        os.close(tmp_fd)
        tmp_vtt = Path(tmp_path)
        try:
            cmd = [
                self._ffmpeg,
                "-y",
                "-nostdin",
                "-i",
                str(media_path),
                "-map",
                f"0:s:{stream_index}",
                "-c:s",
                "webvtt",
                "-f",
                "webvtt",
                str(tmp_vtt),
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            shutil.move(str(tmp_vtt), destination)
        finally:
            tmp_vtt.unlink(missing_ok=True)

    def _convert_to_vtt(self, source: Path, destination: Path) -> None:
        tmp_fd, tmp_path = tempfile.mkstemp(prefix="subtitle-", suffix=".vtt")
        os.close(tmp_fd)
        tmp_vtt = Path(tmp_path)
        try:
            cmd = [
                self._ffmpeg,
                "-y",
                "-nostdin",
                "-i",
                str(source),
                "-f",
                "webvtt",
                str(tmp_vtt),
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            shutil.move(str(tmp_vtt), destination)
        finally:
            tmp_vtt.unlink(missing_ok=True)

    @staticmethod
    def _compose_url(base_url: Optional[str], relative_path: str) -> Optional[str]:
        if not base_url:
            return None
        return base_url.rstrip("/") + "/" + relative_path


__all__ = ["SubtitleService"]
