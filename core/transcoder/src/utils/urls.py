"""URL manipulation helpers."""
from __future__ import annotations


def ensure_trailing_slash(url: str | None) -> str | None:
    if not url:
        return None
    trimmed = url.strip()
    if not trimmed:
        return None
    return trimmed.rstrip("/") + "/"


def strip_trailing_slash(url: str) -> str:
    trimmed = (url or "").strip()
    while trimmed.endswith("/"):
        trimmed = trimmed[:-1]
    return trimmed


__all__ = ["ensure_trailing_slash", "strip_trailing_slash"]

