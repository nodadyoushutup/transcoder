"""Simple in-memory store for the currently playing library item."""
from __future__ import annotations

import copy
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional


def _iso_now() -> str:
    """Return the current UTC time in ISO-8601 format."""

    return datetime.now(timezone.utc).isoformat()


def _safe_int(value: Any) -> Optional[int]:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None
    return numeric


def _sanitize_media(media: Any) -> list[dict[str, Any]]:
    if not isinstance(media, (list, tuple)):
        return []
    sanitized: list[dict[str, Any]] = []
    for entry in media:
        if not isinstance(entry, Mapping):
            continue
        cleaned: dict[str, Any] = {}
        for key, value in entry.items():
            if key == "parts" and isinstance(value, (list, tuple)):
                parts: list[dict[str, Any]] = []
                for part in value:
                    if not isinstance(part, Mapping):
                        continue
                    part_copy = {
                        k: v for k, v in part.items() if k not in {"file", "key"}
                    }
                    streams = part_copy.get("streams")
                    if isinstance(streams, (list, tuple)):
                        part_copy["streams"] = [
                            dict(stream) if isinstance(stream, Mapping) else stream
                            for stream in streams
                        ]
                    parts.append(part_copy)
                cleaned[key] = parts
            else:
                cleaned[key] = value
        sanitized.append(cleaned)
    return sanitized


def _sanitize_item(item: Any) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        return {}
    data = dict(item)
    # Ensure numeric identifiers are serializable and normalized.
    if "rating_key" in data:
        data["rating_key"] = str(data["rating_key"])
    if "library_section_id" in data:
        section_id = _safe_int(data["library_section_id"])
        data["library_section_id"] = section_id
    return data


def _sanitize_details(details: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(details, Mapping):
        return {}

    sanitized: Dict[str, Any] = {}
    item = details.get("item")
    if item:
        sanitized["item"] = _sanitize_item(item)

    for key in (
        "images",
        "extras",
        "children",
        "ratings",
        "guids",
        "chapters",
        "markers",
        "preferences",
        "related",
        "ultra_blur",
    ):
        value = details.get(key)
        if value is not None:
            sanitized[key] = copy.deepcopy(value)

    sanitized["media"] = _sanitize_media(details.get("media"))
    return sanitized


def _sanitize_source(source: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(source, Mapping):
        return {}
    allowed_keys = {
        "media_type",
        "duration",
        "part_id",
        "container",
        "video_codec",
        "audio_codec",
        "item",
    }
    cleaned = {key: value for key, value in source.items() if key in allowed_keys}
    if "item" in cleaned:
        cleaned["item"] = _sanitize_item(cleaned["item"])
    return cleaned


@dataclass
class PlaybackSnapshot:
    """Serializable representation of the current playback item."""

    rating_key: Optional[str]
    library_section_id: Optional[int]
    item: dict[str, Any]
    details: dict[str, Any]
    source: dict[str, Any]
    started_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "rating_key": self.rating_key,
            "library_section_id": self.library_section_id,
            "item": self.item,
            "details": self.details,
            "source": self.source,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


class PlaybackState:
    """Thread-safe tracker for the currently playing library item."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshot: Optional[PlaybackSnapshot] = None

    def clear(self) -> None:
        with self._lock:
            self._snapshot = None

    def update(
        self,
        *,
        rating_key: Optional[str],
        source: Optional[Mapping[str, Any]],
        details: Optional[Mapping[str, Any]],
    ) -> None:
        """Store the most recent playback metadata."""

        sanitized_details = _sanitize_details(details)
        item = sanitized_details.get("item") or _sanitize_item(source.get("item")) if source else {}
        rating = rating_key or item.get("rating_key")
        library_section_id = _safe_int(item.get("library_section_id")) if item else None
        started_at = _iso_now()

        snapshot = PlaybackSnapshot(
            rating_key=str(rating) if rating is not None else None,
            library_section_id=library_section_id,
            item=item or {},
            details=sanitized_details,
            source=_sanitize_source(source),
            started_at=started_at,
            updated_at=started_at,
        )

        with self._lock:
            self._snapshot = snapshot

    def touch(self) -> None:
        """Refresh the update timestamp without mutating content."""

        with self._lock:
            if self._snapshot is None:
                return
            self._snapshot.updated_at = _iso_now()

    def snapshot(self) -> Optional[dict[str, Any]]:
        """Return a serializable copy of the current playback item."""

        with self._lock:
            if self._snapshot is None:
                return None
            data = self._snapshot.to_dict()
        return copy.deepcopy(data)


__all__ = ["PlaybackState"]
