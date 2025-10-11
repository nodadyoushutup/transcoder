"""Periodic background loop for broadcasting controller status updates."""
from __future__ import annotations

import logging
import threading
from typing import Callable, Optional


LOGGER = logging.getLogger(__name__)


class HeartbeatLoop:
    """Run a background thread that invokes a callback at a fixed interval."""

    def __init__(self, interval_seconds: int, callback: Callable[[], None]) -> None:
        self._interval = max(1, int(interval_seconds))
        self._callback = callback
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        thread = self._thread
        if thread and thread.is_alive():
            return

        def _worker() -> None:
            while not self._stop_event.wait(self._interval):
                try:
                    self._callback()
                except Exception:  # pragma: no cover - defensive
                    LOGGER.debug("Heartbeat callback raised an exception", exc_info=True)

        self._stop_event.clear()
        thread = threading.Thread(
            target=_worker,
            name="transcoder-status-heartbeat",
            daemon=True,
        )
        self._thread = thread
        thread.start()

    def stop(self) -> None:
        thread = self._thread
        if thread is None:
            self._stop_event.clear()
            return
        if thread.is_alive():
            self._stop_event.set()
            thread.join(timeout=2.0)
        self._stop_event.clear()
        self._thread = None

    def running(self) -> bool:
        thread = self._thread
        return bool(thread and thread.is_alive())


__all__ = ["HeartbeatLoop"]
