"""Utilities to extract subtitle tracks and convert them to WebVTT."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from .catalog import SubtitleCandidate

LOGGER = logging.getLogger(__name__)


class SubtitleExtractor:
    """Perform container-specific subtitle extraction and conversions."""

    def __init__(
        self,
        *,
        mkvextract: Optional[str] = None,
        ffmpeg: Optional[str] = None,
    ) -> None:
        self._mkvextract = mkvextract
        self._ffmpeg = ffmpeg or shutil.which("ffmpeg") or "ffmpeg"

    def extract(self, media_path: Path, candidate: SubtitleCandidate, destination: Path) -> None:
        if candidate.extractor == "mkv" and candidate.mkv_track_id is not None:
            self._extract_with_mkv(media_path, candidate.mkv_track_id, destination)
            return
        if candidate.extractor == "ffmpeg" and candidate.ffmpeg_index is not None:
            self._extract_with_ffmpeg(media_path, candidate.ffmpeg_index, destination)
            return
        raise RuntimeError(f"Unsupported subtitle candidate configuration: {candidate.public_id}")

    # ------------------------------------------------------------------
    # Container-specific helpers
    # ------------------------------------------------------------------
    def _extract_with_mkv(self, media_path: Path, track_id: int, destination: Path) -> None:
        if not self._mkvextract:
            raise RuntimeError("mkvextract not available")

        tmp_fd, extracted_path = tempfile.mkstemp(prefix="subtitle-", suffix=".raw")
        os.close(tmp_fd)
        extracted_file = Path(extracted_path)
        try:
            cmd = [self._mkvextract, "tracks", str(media_path), f"{track_id}:{extracted_file}"]
            LOGGER.debug("Running mkvextract: %s", cmd)
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
            LOGGER.debug("Running ffmpeg subtitle extraction: %s", cmd)
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
            LOGGER.debug("Running ffmpeg subtitle conversion: %s", cmd)
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            shutil.move(str(tmp_vtt), destination)
        finally:
            tmp_vtt.unlink(missing_ok=True)


__all__ = ["SubtitleExtractor"]
