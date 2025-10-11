"""Session lifecycle helpers for the transcoder controller."""
from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Mapping, Optional, Sequence

from transcoder import EncoderSettings

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class SessionContext:
    """Description of the current transcoder session."""

    session_id: Optional[str]
    session_prefix: Optional[str]
    retain_sessions: tuple[str, ...] = ()


class SessionManager:
    """Track session metadata, retention, and filesystem housekeeping."""

    def __init__(self, *, retention: int = 2) -> None:
        self._lock = Lock()
        self._retention = max(1, int(retention))
        self._history: list[str] = []
        self._known_sessions: set[str] = set()
        self._current_session_id: Optional[str] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def begin(
        self,
        settings: EncoderSettings,
        session_payload: Optional[Mapping[str, object]],
    ) -> SessionContext:
        session_id, retain_sessions, session_prefix = self._parse_payload(session_payload)
        retain_tuple = tuple(retain_sessions)

        with self._lock:
            preserve_ids = self._preserve_ids_locked(session_id, retain_tuple)
            if session_id:
                self._current_session_id = session_id
                self._register_session_locked(session_id)
            else:
                self._current_session_id = None
            for retained in retain_tuple:
                if retained:
                    self._known_sessions.add(retained)

        self._prepare_session_directories(settings, session_prefix, preserve_ids)
        return SessionContext(session_id=session_id, session_prefix=session_prefix, retain_sessions=retain_tuple)

    def complete(self, context: Optional[SessionContext]) -> None:
        session_id = context.session_id if context else None
        with self._lock:
            if session_id:
                if self._current_session_id == session_id:
                    self._current_session_id = None
            else:
                self._current_session_id = None

    def clear_current(self) -> None:
        with self._lock:
            self._current_session_id = None

    # ------------------------------------------------------------------
    # State accessors
    # ------------------------------------------------------------------
    @property
    def current_session_id(self) -> Optional[str]:
        with self._lock:
            return self._current_session_id

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_payload(
        session_payload: Optional[Mapping[str, object]],
    ) -> tuple[Optional[str], list[str], Optional[str]]:
        session_id: Optional[str] = None
        retain_sessions: list[str] = []
        session_prefix: Optional[str] = None

        if session_payload:
            raw_session_id = session_payload.get("id")
            if raw_session_id is not None:
                session_id = str(raw_session_id)
            retain_value = session_payload.get("retain")
            if isinstance(retain_value, Sequence) and not isinstance(retain_value, (str, bytes)):
                retain_sessions = [str(entry) for entry in retain_value if str(entry)]
            prefix_value = session_payload.get("segment_prefix")
            if prefix_value:
                session_prefix = str(prefix_value).strip("/")

        if session_id and not session_prefix:
            session_prefix = f"sessions/{session_id}"
        return session_id, retain_sessions, session_prefix

    def _preserve_ids_locked(
        self,
        session_id: Optional[str],
        retain_sessions: tuple[str, ...],
    ) -> set[str]:
        preserve = {entry for entry in retain_sessions if entry}
        if session_id:
            preserve.add(session_id)
        preserve.update(self._history[-self._retention :])
        return preserve

    def _register_session_locked(self, session_id: str) -> None:
        if not session_id:
            return
        if session_id in self._history:
            self._history.remove(session_id)
        self._history.append(session_id)
        self._known_sessions.add(session_id)
        if len(self._history) > self._retention:
            self._history = self._history[-self._retention :]

    def _prepare_session_directories(
        self,
        settings: EncoderSettings,
        session_prefix: Optional[str],
        preserve_ids: set[str],
    ) -> None:
        if not session_prefix:
            return
        base_dir = settings.output_dir.expanduser().resolve()
        prefix_path = Path(session_prefix.strip("/"))
        session_dir = (base_dir / prefix_path).expanduser().resolve()
        session_dir.mkdir(parents=True, exist_ok=True)
        self._prune_session_directories(base_dir, prefix_path, preserve_ids)

    def _prune_session_directories(
        self,
        base_dir: Path,
        prefix_path: Path,
        preserve_ids: set[str],
    ) -> None:
        if not prefix_path.parts:
            return
        if len(prefix_path.parts) == 1:
            sessions_root = base_dir
        else:
            sessions_root = base_dir.joinpath(*prefix_path.parts[:-1]).expanduser().resolve()
        if not sessions_root.exists() or not sessions_root.is_dir():
            return
        for child in sessions_root.iterdir():
            if not child.is_dir():
                continue
            session_name = child.name
            if session_name in preserve_ids:
                continue
            with self._lock:
                known = session_name in self._known_sessions
            if not known:
                continue
            try:
                shutil.rmtree(child)
                LOGGER.info("Removed stale session artifacts %s", child)
                self._discard_session(session_name)
            except OSError as exc:
                LOGGER.warning("Failed to remove stale session directory %s: %s", child, exc)

    def _discard_session(self, session_name: str) -> None:
        with self._lock:
            self._known_sessions.discard(session_name)
            if session_name in self._history:
                self._history.remove(session_name)


__all__ = ["SessionContext", "SessionManager"]
