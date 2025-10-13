"""Helpers that manage the live transcoder run loop."""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Callable, Optional

from transcoder import DashTranscodePipeline, EncoderSettings, FFmpegDashEncoder, LiveEncodingHandle

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class RunCallbacks:
    """Callbacks used to surface lifecycle events from the runner thread."""

    on_started: Callable[[LiveEncodingHandle, DashTranscodePipeline], None]
    on_completed: Callable[[Optional[LiveEncodingHandle], Optional[DashTranscodePipeline], Optional[BaseException]], None]  # noqa: F821


class TranscodeRunner:
    """Launch FFmpeg + packager processes in a background thread."""

    # ------------------------------------------------------------------
    # Run loop
    # ------------------------------------------------------------------
    def launch(
        self,
        *,
        settings: EncoderSettings,
        session_prefix: Optional[str],
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
                handle = pipeline.start_live()
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


__all__ = ["RunCallbacks", "TranscodeRunner"]
