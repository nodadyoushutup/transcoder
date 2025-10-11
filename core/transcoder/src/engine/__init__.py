"""Engine layer for the transcoder runtime."""
from __future__ import annotations

from .controller import TranscoderController
from .runner import RunCallbacks, SubtitleCollection, TranscodeRunner
from .session_manager import SessionContext, SessionManager
from .status import TranscoderStatusBroadcaster
from .status_snapshot import TranscoderStatus
from .stop_strategy import StopResult, StopStrategy
from .subtitles import SubtitleService

__all__ = [
    "TranscoderController",
    "TranscodeRunner",
    "RunCallbacks",
    "SubtitleCollection",
    "TranscoderStatus",
    "TranscoderStatusBroadcaster",
    "SubtitleService",
    "SessionManager",
    "SessionContext",
    "StopStrategy",
    "StopResult",
]
