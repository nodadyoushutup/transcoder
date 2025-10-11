"""High level subtitle extraction orchestration."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import List, Mapping, Optional, Tuple

from ...utils import sanitize_component
from .catalog import SubtitleCatalog, SubtitleCandidate, SubtitlePreferences
from .extractors import SubtitleExtractor

LOGGER = logging.getLogger(__name__)


class SubtitleService:
    """Extract subtitle streams from media files and convert them to VTT."""

    def __init__(
        self,
        *,
        mkvmerge: Optional[str] = None,
        mkvextract: Optional[str] = None,
        ffprobe: Optional[str] = None,
        ffmpeg: Optional[str] = None,
        catalog: Optional[SubtitleCatalog] = None,
        extractor: Optional[SubtitleExtractor] = None,
    ) -> None:
        resolved_mkvmerge = mkvmerge or shutil.which("mkvmerge")
        resolved_mkvextract = mkvextract or shutil.which("mkvextract")
        resolved_ffprobe = ffprobe or shutil.which("ffprobe") or "ffprobe"
        resolved_ffmpeg = ffmpeg or shutil.which("ffmpeg") or "ffmpeg"

        self._catalog = catalog or SubtitleCatalog(
            mkvmerge=resolved_mkvmerge,
            mkvextract=resolved_mkvextract,
            ffprobe=resolved_ffprobe,
        )
        self._extractor = extractor or SubtitleExtractor(
            mkvextract=resolved_mkvextract,
            ffmpeg=resolved_ffmpeg,
        )

    def collect_tracks(
        self,
        *,
        rating_key: str,
        part_id: Optional[str],
        input_path: str | Path,
        output_dir: Path,
        publish_base_url: Optional[str],
        preferences: Optional[Mapping[str, object]] = None,
    ) -> Tuple[List[dict[str, object]], List[Path]]:
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
            candidates = self._catalog.probe(media_path)
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

        active_preferences = (
            SubtitlePreferences.from_mapping(preferences) if preferences else None
        )
        if active_preferences and active_preferences.is_configured():
            candidates = self._catalog.filter_candidates(candidates, active_preferences)
            LOGGER.info(
                "Subtitle preferences retained %d candidate(s) (rating=%s part=%s lang=%s forced=%s commentary=%s sdh=%s)",
                len(candidates),
                rating_key,
                part_id,
                active_preferences.preferred_language,
                active_preferences.include_forced,
                active_preferences.include_commentary,
                active_preferences.include_sdh,
            )
            if not candidates:
                LOGGER.info(
                    "No subtitle tracks matched the configured preferences (rating=%s part=%s)",
                    rating_key,
                    part_id,
                )
                return [], []

        normalized_rating = sanitize_component(rating_key)
        normalized_part = sanitize_component(part_id)
        target_root = (output_dir / "subtitles" / normalized_rating).expanduser().resolve()
        target_root.mkdir(parents=True, exist_ok=True)

        results: List[dict[str, object]] = []
        files: List[Path] = []

        for candidate in candidates:
            try:
                relative_name = f"{normalized_part}_{candidate.public_id}.vtt"
                destination = target_root / relative_name
                if not destination.exists() or destination.stat().st_size == 0:
                    self._extractor.extract(media_path, candidate, destination)

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

    @staticmethod
    def _compose_url(base_url: Optional[str], relative_path: str) -> Optional[str]:
        if not base_url:
            return None
        return base_url.rstrip("/") + "/" + relative_path


__all__ = ["SubtitleService", "SubtitleCatalog", "SubtitleCandidate", "SubtitlePreferences"]
