"""Library-related Celery tasks."""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

from celery import shared_task
from flask import current_app

from ..services.plex_service import PlexService, PlexServiceError

logger = logging.getLogger(__name__)

LIBRARY_SECTION_QUEUE = os.getenv("CELERY_LIBRARY_QUEUE", "library_sections")


def _plex_service() -> PlexService:
    plex: PlexService = current_app.extensions["plex_service"]
    return plex


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def refresh_plex_sections_snapshot(self, *, force_refresh: bool = False) -> Dict[str, Any]:
    """Build and persist the Plex sections snapshot in Redis."""

    plex = _plex_service()
    try:
        logger.info("Starting Plex sections snapshot refresh (force_refresh=%s)", force_refresh)
        snapshot = plex.build_sections_snapshot(force_refresh=force_refresh)
    except PlexServiceError as exc:
        logger.warning("Plex sections snapshot failed: %s", exc)
        raise self.retry(exc=exc)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Unexpected failure generating Plex sections snapshot")
        raise self.retry(exc=exc)

    sections = snapshot.get("sections", []) if isinstance(snapshot, dict) else []
    logger.info(
        "Completed Plex sections snapshot (sections=%d, generated_at=%s)",
        len(sections),
        snapshot.get("generated_at"),
    )
    return {
        "sections": len(sections),
        "generated_at": snapshot.get("generated_at"),
    }

def enqueue_sections_snapshot_refresh(*, force_refresh: bool = False) -> bool:
    """Attempt to run the snapshot refresh in the background."""

    try:
        refresh_plex_sections_snapshot.delay(force_refresh=force_refresh)
    except Exception as exc:  # pragma: no cover - Celery connectivity
        logger.warning("Unable to enqueue Plex sections snapshot refresh: %s", exc)
        return False
    return True

@shared_task(bind=True, max_retries=3, default_retry_delay=45, queue=LIBRARY_SECTION_QUEUE)
def fetch_section_snapshot_chunk(
    self,
    *,
    section_id: Any,
    sort: Optional[str] = None,
    letter: Optional[str] = None,
    search: Optional[str] = None,
    watch: Optional[str] = None,
    genre: Optional[str] = None,
    collection: Optional[str] = None,
    year: Optional[str] = None,
    offset: int = 0,
    limit: int = 500,
) -> Dict[str, Any]:
    """Load a snapshot chunk for a section and merge it into Redis."""

    plex = _plex_service()
    try:
        summary = plex.fetch_section_snapshot_chunk(
            section_id,
            sort=sort,
            letter=letter,
            search=search,
            watch_state=watch,
            genre=genre,
            collection=collection,
            year=year,
            offset=offset,
            limit=limit,
        )
    except PlexServiceError as exc:
        logger.warning(
            "Snapshot chunk failed for section=%s offset=%s (retrying): %s",
            section_id,
            offset,
            exc,
        )
        raise self.retry(exc=exc)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception(
            "Unexpected failure fetching snapshot chunk for section=%s offset=%s",
            section_id,
            offset,
        )
        raise self.retry(exc=exc)

    logger.info(
        "Cached snapshot chunk (section=%s, offset=%s, cached=%s, total=%s)",
        section_id,
        offset,
        summary.get("cached"),
        summary.get("total"),
    )
    return summary


@shared_task(bind=True, max_retries=2, default_retry_delay=30, queue=LIBRARY_SECTION_QUEUE)
def build_section_snapshot_task(
    self,
    *,
    section_id: Any,
    sort: Optional[str] = None,
    page_size: Optional[int] = None,
    max_items: Optional[int] = None,
    parallelism: Optional[int] = None,
    letter: Optional[str] = None,
    search: Optional[str] = None,
    watch: Optional[str] = None,
    genre: Optional[str] = None,
    collection: Optional[str] = None,
    year: Optional[str] = None,
    reset: bool = False,
) -> Dict[str, Any]:
    """Populate or refresh the cached snapshot for a specific Plex section."""

    plex = _plex_service()
    try:
        plan = plex.prepare_section_snapshot_plan(
            section_id,
            sort=sort,
            letter=letter,
            search=search,
            watch_state=watch,
            genre=genre,
            collection=collection,
            year=year,
            page_size=page_size,
            max_items=max_items,
            reset=reset,
        )
    except PlexServiceError as exc:
        logger.warning(
            "Snapshot plan failed for section=%s (retrying): %s",
            section_id,
            exc,
        )
        raise self.retry(exc=exc)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Unexpected failure preparing snapshot plan for %s", section_id)
        raise self.retry(exc=exc)

    offsets = plan.get("queued_offsets", []) if isinstance(plan, dict) else []
    chunk_limit = plan.get("limit") if isinstance(plan, dict) else page_size
    if not isinstance(chunk_limit, int) or chunk_limit <= 0:
        chunk_limit = page_size if isinstance(page_size, int) and page_size > 0 else 500

    max_concurrent = None
    if parallelism is not None:
        try:
            parsed_parallelism = int(parallelism)
            if parsed_parallelism > 0:
                max_concurrent = parsed_parallelism
        except (TypeError, ValueError):
            max_concurrent = None

    scheduled_offsets = offsets

    for offset in scheduled_offsets:
        try:
            fetch_section_snapshot_chunk.apply_async(
                kwargs={
                    "section_id": section_id,
                    "sort": sort,
                    "letter": letter,
                    "search": search,
                    "watch": watch,
                    "genre": genre,
                    "collection": collection,
                    "year": year,
                    "offset": offset,
                    "limit": chunk_limit,
                },
            )
        except Exception as exc:  # pragma: no cover - Celery connectivity
            logger.warning(
                "Unable to enqueue snapshot chunk (section=%s offset=%s): %s",
                section_id,
                offset,
                exc,
            )

    plan["enqueued"] = len(scheduled_offsets)
    plan["queued_offsets"] = offsets
    if max_concurrent is not None:
        plan["parallelism"] = max_concurrent

    logger.info(
        "Snapshot plan ready (section=%s, cached=%s, total=%s, scheduled_chunks=%s)",
        section_id,
        plan.get("cached"),
        plan.get("total"),
        plan.get("enqueued"),
    )
    return plan


def enqueue_section_snapshot_build(
    *,
    section_id: Any,
    sort: Optional[str] = None,
    page_size: Optional[int] = None,
    max_items: Optional[int] = None,
    parallelism: Optional[int] = None,
    letter: Optional[str] = None,
    search: Optional[str] = None,
    watch: Optional[str] = None,
    genre: Optional[str] = None,
    collection: Optional[str] = None,
    year: Optional[str] = None,
    reset: bool = False,
) -> Optional[str]:
    """Schedule a background build of the section snapshot."""

    try:
        async_result = build_section_snapshot_task.delay(
            section_id=section_id,
            sort=sort,
            page_size=page_size,
            max_items=max_items,
            parallelism=parallelism,
            letter=letter,
            search=search,
            watch=watch,
            genre=genre,
            collection=collection,
            year=year,
            reset=reset,
        )
    except Exception as exc:  # pragma: no cover - Celery connectivity
        logger.warning("Unable to enqueue section snapshot build for %s: %s", section_id, exc)
        return None
    return async_result.id


__all__ = [
    "refresh_plex_sections_snapshot",
    "enqueue_sections_snapshot_refresh",
    "fetch_section_snapshot_chunk",
    "build_section_snapshot_task",
    "enqueue_section_snapshot_build",
]
