"""String helper utilities shared across the transcoder service."""
from __future__ import annotations

import re

_SANITIZE_PATTERN = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_component(value: object, *, fallback: str = "track") -> str:
    text = str(value) if value is not None else ""
    sanitized = _SANITIZE_PATTERN.sub("_", text)
    return sanitized or fallback


__all__ = ["sanitize_component"]

