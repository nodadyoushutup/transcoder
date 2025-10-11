"""Generic coercion utilities shared across the transcoder codebase."""
from __future__ import annotations

from typing import Any, Iterable, Optional, Sequence, Tuple


def to_bool(value: Any, *, allow_blank_false: bool = True) -> bool:
    """Best-effort conversion of common truthy/falsey inputs to ``bool``."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        truthy = {"true", "1", "yes", "on"}
        falsy = {"false", "0", "no", "off"}
        if allow_blank_false:
            falsy.add("")
        if lowered in truthy:
            return True
        if lowered in falsy:
            return False
    return False


def to_optional_bool(value: Any) -> Optional[bool]:
    """Variant of :func:`to_bool` that returns ``None`` when indeterminate."""

    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off", ""}:
            return False
    return None


def to_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def to_string_sequence(value: Any) -> Optional[Tuple[str, ...]]:
    if value is None:
        return None
    if isinstance(value, (list, tuple, set)):
        return tuple(str(item) for item in value)
    return (str(value),)


def coerce_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


__all__ = [
    "to_bool",
    "to_optional_bool",
    "to_optional_int",
    "to_optional_float",
    "to_optional_str",
    "to_string_sequence",
    "coerce_int",
]

