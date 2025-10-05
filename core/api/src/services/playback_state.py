"""Simple in-memory store for the currently playing library item."""
from __future__ import annotations

import copy
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, Iterable, Mapping, Optional, Tuple

if TYPE_CHECKING:  # pragma: no cover - typing helper
    from .redis_service import RedisService


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
    subtitles: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "rating_key": self.rating_key,
            "library_section_id": self.library_section_id,
            "item": self.item,
            "details": self.details,
            "source": self.source,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "subtitles": self.subtitles,
        }


class PlaybackState:
    """Thread-safe tracker for the currently playing library item."""

    REDIS_NAMESPACE = "playback"
    REDIS_KEY = "snapshot"

    def __init__(self, *, redis_service: Optional["RedisService"] = None) -> None:
        self._lock = threading.Lock()
        self._snapshot: Optional[PlaybackSnapshot] = None
        self._redis = redis_service
        self._transcoder_running = False
        self._has_seen_running = False

    def clear(self) -> None:
        if self._use_redis():
            self._redis.delete(self.REDIS_NAMESPACE, self.REDIS_KEY)  # type: ignore[union-attr]
        with self._lock:
            self._snapshot = None
            self._transcoder_running = False
            self._has_seen_running = False

    def update(
        self,
        *,
        rating_key: Optional[str],
        source: Optional[Mapping[str, Any]],
        details: Optional[Mapping[str, Any]],
        subtitles: Optional[Iterable[Mapping[str, Any]]] = None,
    ) -> None:
        """Store the most recent playback metadata."""

        sanitized_details = _sanitize_details(details)
        item = sanitized_details.get("item") or _sanitize_item(source.get("item")) if source else {}
        rating = rating_key or item.get("rating_key")
        library_section_id = _safe_int(item.get("library_section_id")) if item else None
        started_at = _iso_now()

        sanitized_subtitles: list[dict[str, Any]] = []
        if subtitles:
            for entry in subtitles:
                if isinstance(entry, Mapping):
                    sanitized_subtitles.append(dict(entry))

        snapshot = PlaybackSnapshot(
            rating_key=str(rating) if rating is not None else None,
            library_section_id=library_section_id,
            item=item or {},
            details=sanitized_details,
            source=_sanitize_source(source),
            started_at=started_at,
            updated_at=started_at,
            subtitles=sanitized_subtitles,
        )

        if self._use_redis():
            self._redis.json_set(self.REDIS_NAMESPACE, self.REDIS_KEY, snapshot.to_dict())  # type: ignore[union-attr]
            with self._lock:
                self._snapshot = snapshot
                self._transcoder_running = False
                self._has_seen_running = False
            return

        with self._lock:
            self._snapshot = snapshot
            self._transcoder_running = False
            self._has_seen_running = False

    def touch(self) -> None:
        """Refresh the update timestamp without mutating content."""

        if self._use_redis():
            payload = self._redis.json_get(self.REDIS_NAMESPACE, self.REDIS_KEY)  # type: ignore[union-attr]
            if not isinstance(payload, dict):
                return
            payload["updated_at"] = _iso_now()
            self._redis.json_set(self.REDIS_NAMESPACE, self.REDIS_KEY, payload)  # type: ignore[union-attr]
            with self._lock:
                if self._snapshot is not None:
                    self._snapshot.updated_at = payload["updated_at"]
            return

        with self._lock:
            if self._snapshot is None:
                return
            self._snapshot.updated_at = _iso_now()

    def snapshot(self) -> Optional[dict[str, Any]]:
        """Return a serializable copy of the current playback item."""

        if self._use_redis():
            payload = self._redis.json_get(self.REDIS_NAMESPACE, self.REDIS_KEY)  # type: ignore[union-attr]
            if isinstance(payload, dict):
                return copy.deepcopy(payload)

        with self._lock:
            if self._snapshot is None:
                return None
            data = self._snapshot.to_dict()
        return copy.deepcopy(data)

    def update_transcoder_running(self, running: bool) -> Tuple[bool, bool]:
        """Track the most recent transcoder running state.

        Returns ``(previous_running, has_seen_running)`` where ``has_seen_running``
        indicates whether a running state has been observed since the last
        playback update.
        """

        with self._lock:
            previous = self._transcoder_running
            if running:
                self._transcoder_running = True
                self._has_seen_running = True
            else:
                self._transcoder_running = False
            return previous, self._has_seen_running

    def _use_redis(self) -> bool:
        return bool(self._redis and self._redis.available)


__all__ = ["PlaybackState"]
