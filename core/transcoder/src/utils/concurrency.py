"""Concurrency-related helpers."""
from __future__ import annotations

import time
from threading import Event


def sleep_with_stop(seconds: float, stop_event: Event) -> None:
    deadline = time.monotonic() + max(0.0, seconds)
    while time.monotonic() < deadline and not stop_event.is_set():
        remaining = deadline - time.monotonic()
        time.sleep(min(remaining, 0.25))


__all__ = ["sleep_with_stop"]

