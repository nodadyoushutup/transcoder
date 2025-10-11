"""Helpers that manage the live transcoder run loop."""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Mapping, Optional, Sequence

from transcoder import DashTranscodePipeline, EncoderSettings, FFmpegDashEncoder, LiveEncodingHandle

from .subtitles import SubtitleService
from ..utils import ensure_trailing_slash

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class RunCallbacks:
    """Callbacks used to surface lifecycle events from the runner thread."""

    on_started: Callable[[LiveEncodingHandle, DashTranscodePipeline], None]
    on_completed: Callable[[Optional[LiveEncodingHandle], Optional[DashTranscodePipeline], Optional[BaseException]], None]  # noqa: F821


@dataclass(frozen=True)
class SubtitleCollection:
    """Result of collecting subtitle metadata and auxiliary assets."""

    tracks: List[Mapping[str, object]]
    assets: List[Path]
    error: Optional[BaseException] = None


class TranscodeRunner:
    """Launch FFmpeg + packager processes in a background thread."""

    def __init__(self, subtitle_service: SubtitleService) -> None:
        self._subtitle_service = subtitle_service

    # ------------------------------------------------------------------
    # Subtitle preparation
    # ------------------------------------------------------------------
    def collect_subtitles(
        self,
        *,
        settings: EncoderSettings,
        publish_url: Optional[str],
        subtitle_metadata: Optional[Mapping[str, object]],
        suppress_errors: bool = True,
    ) -> SubtitleCollection:
        """Collect subtitle tracks and supporting assets for a run."""

        if not subtitle_metadata:
            return SubtitleCollection(tracks=[], assets=[])

        normalized_publish = ensure_trailing_slash(publish_url)
        rating_key = str(subtitle_metadata.get("rating_key") or "unknown")
        part_id = subtitle_metadata.get("part_id")

        preferences = subtitle_metadata.get("preferences")

        try:
            tracks, assets = self._subtitle_service.collect_tracks(
                rating_key=rating_key,
                part_id=part_id,
                input_path=settings.input_path,
                output_dir=settings.output_dir,
                publish_base_url=normalized_publish,
                preferences=preferences if isinstance(preferences, Mapping) else None,
            )
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.warning("Subtitle extraction failed: %s", exc)
            if suppress_errors:
                return SubtitleCollection(tracks=[], assets=[], error=exc)
            raise

        return SubtitleCollection(tracks=list(tracks), assets=list(assets))

    # ------------------------------------------------------------------
    # Run loop
    # ------------------------------------------------------------------
    def launch(
        self,
        *,
        settings: EncoderSettings,
        session_prefix: Optional[str],
        subtitle_assets: Sequence[Path],
        callbacks: RunCallbacks,
    ) -> threading.Thread:
        """Start the FFmpeg pipeline in a background thread."""

        def _runner() -> None:
            handle: Optional[LiveEncodingHandle] = None
            pipeline: Optional[DashTranscodePipeline] = None
            try:
                encoder = FFmpegDashEncoder(settings)
                pipeline = DashTranscodePipeline(
                    encoder,
                    session_prefix=session_prefix,
                )
                handle = pipeline.start_live(static_assets=list(subtitle_assets))
                callbacks.on_started(handle, pipeline)
                packager_pid = handle.packager_process.pid if handle.packager_process else None
                LOGGER.info(
                    "Started transcoder (ffmpeg_pid=%s packager_pid=%s)",
                    handle.process.pid,
                    packager_pid,
                )
                handle.wait()
                LOGGER.info("Transcoder exited with %s", handle.process.returncode)
                callbacks.on_completed(handle, pipeline, None)
            except Exception as exc:  # pragma: no cover - defensive, depends on FFmpeg
                LOGGER.exception("Transcoder run failed")
                callbacks.on_completed(handle, pipeline, exc)

        thread = threading.Thread(target=_runner, name="transcoder-runner", daemon=True)
        thread.start()
        return thread


__all__ = ["RunCallbacks", "SubtitleCollection", "TranscodeRunner"]
