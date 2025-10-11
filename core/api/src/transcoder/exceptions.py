"""Custom exceptions raised by the transcoder package."""
from __future__ import annotations


class TranscoderError(RuntimeError):
    """Base error for the transcoder package."""


class MediaProbeError(TranscoderError):
    """Raised when a source file cannot be inspected with ffprobe."""


class FFmpegExecutionError(TranscoderError):
    """Raised when the FFmpeg process fails or exits unexpectedly."""
