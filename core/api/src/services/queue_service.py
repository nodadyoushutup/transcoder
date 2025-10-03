"""Persistent queue management helpers."""
from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterable, List, Mapping, MutableMapping, Optional

from sqlalchemy import Select, select
from sqlalchemy.orm import joinedload

from ..extensions import db
from ..models import QueueItem, User
from .playback_coordinator import PlaybackCoordinator, PlaybackCoordinatorError, PlaybackResult
from .playback_state import PlaybackState
from .plex_service import PlexService, PlexServiceError

if TYPE_CHECKING:  # pragma: no cover - typing helper
    from .redis_service import RedisService

LOGGER = logging.getLogger(__name__)


class QueueError(RuntimeError):
    """Raised when queue operations cannot be completed."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_duration_ms(details: Optional[Mapping[str, Any]]) -> Optional[int]:
    if not details:
        return None
    item = details.get("item") if isinstance(details, Mapping) else None
    candidates: List[Optional[Any]] = []
    if isinstance(item, Mapping):
        candidates.extend([item.get("duration"), item.get("duration_ms")])
    media = details.get("media") if isinstance(details, Mapping) else None
    if isinstance(media, Iterable):
        for entry in media:
            if isinstance(entry, Mapping):
                candidates.append(entry.get("duration"))
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            numeric = int(candidate)
        except (TypeError, ValueError):
            continue
        if numeric > 0:
            return numeric
    return None


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


class QueueService:
    """Central coordinator for queue persistence and orchestration."""

    def __init__(
        self,
        *,
        plex_service: PlexService,
        playback_state: PlaybackState,
        playback_coordinator: PlaybackCoordinator,
        redis_service: Optional["RedisService"] = None,
    ) -> None:
        self._plex = plex_service
        self._playback_state = playback_state
        self._coordinator = playback_coordinator
        self._lock = threading.Lock()
        self._redis = redis_service
        self._auto_advance = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    @property
    def auto_advance_enabled(self) -> bool:
        if self._redis and self._redis.available:
            payload = self._redis.json_get("queue", "auto_advance")
            if isinstance(payload, dict):
                return bool(payload.get("enabled"))
            return False
        with self._lock:
            return self._auto_advance

    def arm(self) -> None:
        if self._redis and self._redis.available:
            self._redis.json_set("queue", "auto_advance", {"enabled": True})
        with self._lock:
            if not self._auto_advance:
                LOGGER.debug("Queue auto-advance armed")
            self._auto_advance = True

    def disarm(self) -> None:
        if self._redis and self._redis.available:
            self._redis.delete("queue", "auto_advance")
        with self._lock:
            if self._auto_advance:
                LOGGER.debug("Queue auto-advance disarmed")
            self._auto_advance = False

    def snapshot(self) -> Mapping[str, Any]:
        playback_snapshot = self._playback_state.snapshot()
        items = self._ordered_items()
        schedule = self._build_schedule(playback_snapshot, items)
        serialized_items = [
            self._serialize_item(item, schedule.get(item.id))
            for item in items
        ]
        return {
            "generated_at": _utc_now().isoformat(),
            "current": self._serialize_current(playback_snapshot),
            "items": serialized_items,
            "auto_advance": self.auto_advance_enabled,
        }

    def enqueue(
        self,
        *,
        rating_key: str,
        part_id: Optional[str] = None,
        mode: str = "last",
        index: Optional[int] = None,
        requested_by: Optional[User] = None,
    ) -> Mapping[str, Any]:
        details = self._fetch_details(rating_key)
        duration_ms = _coerce_duration_ms(details)
        item_payload = self._build_item_payload(details)

        with self._acquire_lock():
            items = self._ordered_items_locked()
            position = self._determine_insert_position(mode, index, len(items))
            if position <= len(items):
                self._bump_positions_locked(position)
            queue_item = QueueItem(
                rating_key=rating_key,
                part_id=part_id,
                library_section_id=item_payload.get("library_section_id"),
                duration_ms=duration_ms,
                title=item_payload.get("title"),
                grandparent_title=item_payload.get("grandparent_title"),
                thumb=item_payload.get("thumb"),
                art=item_payload.get("art"),
                data=item_payload,
                position=position,
                requested_by_id=requested_by.id if requested_by else None,
            )
            db.session.add(queue_item)
            db.session.flush()
            self._resequence_locked()
            db.session.commit()
            db.session.refresh(queue_item)

        LOGGER.info(
            "Enqueued item rating_key=%s at position=%s (mode=%s)",
            rating_key,
            queue_item.position,
            mode,
        )
        snapshot = self._playback_state.snapshot()
        ordered_items = self._ordered_items()
        schedule_map = self._build_schedule(snapshot, ordered_items)
        for item in ordered_items:
            if item.id == queue_item.id:
                return self._serialize_item(item, schedule_map.get(item.id))
        return self._serialize_item(queue_item)

    def move_item(self, item_id: int, direction: str) -> bool:
        with self._acquire_lock():
            items = self._ordered_items_locked()
            if not items:
                return False
            index_map = {item.id: idx for idx, item in enumerate(items)}
            if item_id not in index_map:
                return False
            idx = index_map[item_id]
            if direction == "up":
                if idx == 0:
                    return False
                target_idx = idx - 1
            elif direction == "down":
                if idx >= len(items) - 1:
                    return False
                target_idx = idx + 1
            else:
                raise QueueError("Unsupported move direction", status_code=400)

            current_item = items[idx]
            target_item = items[target_idx]
            current_item.position, target_item.position = target_item.position, current_item.position
            self._resequence_locked()
            db.session.commit()
            LOGGER.debug(
                "Moved queue item id=%s direction=%s (new position=%s)",
                item_id,
                direction,
                current_item.position,
            )
            return True

    def remove_item(self, item_id: int) -> bool:
        with self._acquire_lock():
            item = self._get_item_locked(item_id)
            if not item:
                return False
            db.session.delete(item)
            self._resequence_locked()
            db.session.commit()
            LOGGER.info("Removed queue item id=%s", item_id)
            return True

    def clear(self) -> None:
        with self._acquire_lock():
            db.session.query(QueueItem).delete()
            db.session.commit()
            self._auto_advance = False
            LOGGER.info("Cleared queue")
        if self._redis and self._redis.available:
            self._redis.delete("queue", "auto_advance")

    def ensure_progress(self, status_payload: Optional[Mapping[str, Any]] = None) -> Optional[PlaybackResult]:
        if not self.auto_advance_enabled:
            return None
        running = bool(status_payload.get("running")) if status_payload else None
        if running:
            return None
        return self.play_next()

    def play_next(self) -> Optional[PlaybackResult]:
        empty_queue = False
        serialized: Optional[Mapping[str, Any]] = None
        with self._acquire_lock():
            next_item = self._next_item_locked()
            if not next_item:
                self._auto_advance = False
                empty_queue = True
            else:
                serialized = self._serialize_item(next_item)
                db.session.delete(next_item)
                self._resequence_locked()
                db.session.commit()

        if empty_queue:
            if self._redis and self._redis.available:
                self._redis.delete("queue", "auto_advance")
            return None

        LOGGER.info(
            "Starting playback for queued item id=%s rating_key=%s",
            serialized["id"],
            serialized["rating_key"],
        )
        try:
            result = self._coordinator.start_playback(serialized["rating_key"], part_id=serialized.get("part_id"))
        except PlaybackCoordinatorError as exc:
            LOGGER.error(
                "Failed to start playback for queue item rating_key=%s: %s",
                serialized["rating_key"],
                exc,
            )
            # Reinsert item at front so it is not lost.
            with self._acquire_lock():
                self._insert_front_locked(serialized)
            raise QueueError(str(exc), status_code=exc.status_code)

        self.arm()
        return result

    def skip_current(self) -> Optional[PlaybackResult]:
        try:
            status_code, _payload = self._coordinator.stop_playback()
        except PlaybackCoordinatorError as exc:
            raise QueueError(str(exc), status_code=exc.status_code) from exc
        if status_code not in (200, 202, 204, 409):
            raise QueueError(f"Unable to stop current playback ({status_code})", status_code=502)
        return self.play_next()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _ordered_items(self) -> List[QueueItem]:
        stmt = self._base_query()
        return list(db.session.execute(stmt).scalars().unique())

    def _ordered_items_locked(self) -> List[QueueItem]:
        stmt = self._base_query()
        return list(db.session.execute(stmt).scalars().unique())

    @contextmanager
    def _acquire_lock(self):
        if self._redis and self._redis.available:
            try:
                with self._redis.lock("queue:mutex", timeout=60, blocking_timeout=60):
                    with self._lock:
                        yield
                return
            except TimeoutError as exc:
                raise QueueError("Queue is currently busy. Please retry shortly.", status_code=503) from exc
        with self._lock:
            yield

    @staticmethod
    def _base_query() -> Select:
        return (
            select(QueueItem)
            .options(joinedload(QueueItem.requested_by))
            .order_by(QueueItem.position.asc(), QueueItem.id.asc())
        )

    def _next_item_locked(self) -> Optional[QueueItem]:
        stmt = self._base_query().limit(1)
        return db.session.execute(stmt).scalar_one_or_none()

    def _get_item_locked(self, item_id: int) -> Optional[QueueItem]:
        stmt = (
            select(QueueItem)
            .options(joinedload(QueueItem.requested_by))
            .filter(QueueItem.id == item_id)
            .limit(1)
        )
        return db.session.execute(stmt).scalar_one_or_none()

    def _resequence_locked(self) -> None:
        stmt = self._base_query()
        items = list(db.session.execute(stmt).scalars().unique())
        for index, item in enumerate(items, start=1):
            if item.position != index:
                item.position = index
        db.session.flush()

    def _bump_positions_locked(self, start_position: int) -> None:
        stmt = (
            select(QueueItem)
            .filter(QueueItem.position >= start_position)
            .order_by(QueueItem.position.desc())
        )
        for item in db.session.execute(stmt).scalars():
            item.position += 1
        db.session.flush()

    def _determine_insert_position(self, mode: str, index: Optional[int], length: int) -> int:
        if mode == "next":
            return 1
        if mode == "last":
            return length + 1
        if mode == "index":
            target = index if index is not None else length
            if target < 0:
                target = 0
            if target > length:
                target = length
            return target + 1
        raise QueueError("Unsupported queue insert mode", status_code=400)

    def _fetch_details(self, rating_key: str) -> Mapping[str, Any]:
        try:
            details = self._plex.item_details(rating_key)
        except PlexServiceError as exc:
            raise QueueError(str(exc), status_code=502) from exc
        if not isinstance(details, Mapping):
            raise QueueError("Failed to load item details", status_code=502)
        return details

    @staticmethod
    def _build_item_payload(details: Mapping[str, Any]) -> Mapping[str, Any]:
        item = details.get("item") if isinstance(details, Mapping) else {}
        if not isinstance(item, Mapping):
            item = {}
        payload: dict[str, Any] = {
            "title": item.get("title"),
            "grandparent_title": item.get("grandparent_title"),
            "thumb": item.get("thumb"),
            "art": item.get("art"),
            "summary": item.get("summary"),
            "year": item.get("year"),
            "library_section_id": item.get("library_section_id"),
            "details": details,
        }
        return payload

    def _build_schedule(
        self,
        playback_snapshot: Optional[Mapping[str, Any]],
        items: Iterable[QueueItem],
    ) -> Mapping[int, Mapping[str, Optional[str]]]:
        schedule: dict[int, Mapping[str, Optional[str]]] = {}
        now = _utc_now()
        cursor = now
        if playback_snapshot:
            started = _parse_iso_datetime(playback_snapshot.get("started_at"))
            duration_ms = _coerce_duration_ms(playback_snapshot.get("details"))
            if duration_ms is None:
                duration_ms = _coerce_duration_ms(playback_snapshot.get("source"))
            if started and duration_ms:
                end = started + timedelta(milliseconds=duration_ms)
                cursor = max(end, now)
        for item in items:
            duration_ms = item.duration_ms
            start_time = cursor
            if duration_ms:
                end_time = cursor + timedelta(milliseconds=duration_ms)
            else:
                end_time = None
            schedule[item.id] = {
                "start_at": start_time.isoformat(),
                "end_at": end_time.isoformat() if end_time else None,
            }
            if duration_ms:
                cursor = end_time or cursor
        return schedule

    def _serialize_current(self, snapshot: Optional[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
        if not snapshot:
            return None
        duration_ms = _coerce_duration_ms(snapshot.get("details"))
        if duration_ms is None:
            duration_ms = _coerce_duration_ms(snapshot.get("source"))
        item_info = snapshot.get("item") if isinstance(snapshot.get("item"), Mapping) else {}
        details_info = snapshot.get("details") if isinstance(snapshot.get("details"), Mapping) else {}
        details_item = details_info.get("item") if isinstance(details_info.get("item"), Mapping) else {}
        summary = details_item.get("summary") or item_info.get("summary")
        year = details_item.get("year") or item_info.get("year")
        thumb = details_item.get("thumb") or item_info.get("thumb")
        art = details_item.get("art") or item_info.get("art")
        return {
            "rating_key": snapshot.get("rating_key"),
            "library_section_id": snapshot.get("library_section_id"),
            "item": snapshot.get("item"),
            "details": snapshot.get("details"),
            "source": snapshot.get("source"),
            "started_at": snapshot.get("started_at"),
            "updated_at": snapshot.get("updated_at"),
            "duration_ms": duration_ms,
            "summary": summary,
            "year": year,
            "thumb": thumb,
            "art": art,
        }

    def _serialize_item(
        self,
        item: QueueItem,
        schedule_entry: Optional[Mapping[str, Optional[str]]] = None,
    ) -> Mapping[str, Any]:
        requested_by = item.requested_by
        requester_data = None
        if requested_by is not None:
            display_name = getattr(requested_by, "display_name", None)
            if not display_name:
                display_name = getattr(requested_by, "username", None)
            requester_data = {
                "id": requested_by.id,
                "username": requested_by.username,
                "display_name": display_name,
            }
        schedule_entry = schedule_entry or {}
        details_payload = item.data.get("details") if isinstance(item.data, Mapping) else None
        details_item = details_payload.get("item") if isinstance(details_payload, Mapping) else {}
        stored_summary = None
        stored_year = None
        if isinstance(item.data, Mapping):
            stored_summary = item.data.get("summary")
            stored_year = item.data.get("year")
        if stored_summary is None and isinstance(details_item, Mapping):
            stored_summary = details_item.get("summary")
        if stored_year is None and isinstance(details_item, Mapping):
            stored_year = details_item.get("year")
        return {
            "id": item.id,
            "rating_key": item.rating_key,
            "part_id": item.part_id,
            "library_section_id": item.library_section_id,
            "position": item.position,
            "title": item.title,
            "grandparent_title": item.grandparent_title,
            "thumb": item.thumb,
            "art": item.art,
            "summary": stored_summary,
            "year": stored_year,
            "duration_ms": item.duration_ms,
            "requested_by": requester_data,
            "start_at": schedule_entry.get("start_at"),
            "end_at": schedule_entry.get("end_at"),
            "created_at": item.created_at.isoformat(),
            "details": details_payload or {},
        }

    def _insert_front_locked(self, serialized_item: Mapping[str, Any]) -> None:
        self._bump_positions_locked(1)
        queue_item = QueueItem(
            rating_key=serialized_item.get("rating_key"),
            part_id=serialized_item.get("part_id"),
            library_section_id=serialized_item.get("library_section_id"),
            duration_ms=serialized_item.get("duration_ms"),
            title=serialized_item.get("title"),
            grandparent_title=serialized_item.get("grandparent_title"),
            thumb=serialized_item.get("thumb"),
            art=serialized_item.get("art"),
            data=None,
            position=1,
            requested_by_id=(serialized_item.get("requested_by") or {}).get("id"),
        )
        db.session.add(queue_item)
        db.session.flush()
        self._resequence_locked()
        db.session.commit()


__all__ = [
    "QueueService",
    "QueueError",
]
