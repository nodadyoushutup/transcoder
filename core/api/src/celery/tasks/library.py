"""Library-related Celery tasks."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional

from celery import shared_task
from flask import current_app

from ...services.plex_service import PlexService, PlexServiceError

logger = logging.getLogger(__name__)

LIBRARY_SECTION_QUEUE = os.getenv("CELERY_LIBRARY_QUEUE", "library_sections")
IMAGE_CACHE_QUEUE = os.getenv("CELERY_IMAGE_CACHE_QUEUE", "library_images")


def _plex_service() -> PlexService:
    plex: PlexService = current_app.extensions["plex_service"]
    return plex


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name="core.api.src.celery.tasks.library.refresh_plex_sections_snapshot",
)
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

@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=45,
    queue=LIBRARY_SECTION_QUEUE,
    name="core.api.src.celery.tasks.library.fetch_section_snapshot_chunk",
)
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


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    queue=LIBRARY_SECTION_QUEUE,
    name="core.api.src.celery.tasks.library.build_section_snapshot_task",
)
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


@shared_task(
    bind=True,
    queue=IMAGE_CACHE_QUEUE,
    name="core.api.src.celery.tasks.library.cache_single_image_task",
    ignore_result=False,
)
def cache_single_image_task(
    self,
    *,
    section_id: str,
    path: str,
    detail_params: Optional[Dict[str, Any]] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """Cache an individual Plex artwork asset."""

    plex = _plex_service()
    params = detail_params or {}
    try:
        stats = plex._precache_image(
            path,
            params=params,
            ensure_grid=True,
            force=force,
        )
    except PlexServiceError as exc:
        logger.warning(
            "Failed to cache Plex image (section=%s, path=%s): %s",
            section_id,
            path,
            exc,
        )
        return {
            "path": path,
            "error": str(exc),
            "fetched": False,
            "grid_created": False,
        }
    return {
        "path": stats.get("path", path),
        "error": None,
        "fetched": bool(stats.get("fetched")),
        "grid_created": bool(stats.get("grid_created")),
    }


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=45,
    queue=IMAGE_CACHE_QUEUE,
    name="core.api.src.celery.tasks.library.cache_section_images_task",
)
def cache_section_images_task(
    self,
    *,
    section_id: Any,
    page_size: Optional[int] = None,
    max_items: Optional[int] = None,
    detail_params: Optional[Dict[str, Any]] = None,
    grid_params: Optional[Dict[str, Any]] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """Populate cached artwork for a given Plex section, fanning out per asset."""

    plex = _plex_service()
    flask_app = current_app
    redis_service = flask_app.extensions.get("redis_service") if flask_app else None

    summary = {
        "section_id": str(section_id),
        "processed_items": 0,
        "unique_original": 0,
        "unique_grid": 0,
        "downloads": 0,
        "skipped": 0,
        "grid_generated": 0,
        "errors": [],
        "enqueued": 0,
        "children": [],
    }

    try:
        library_settings = plex._library_settings()
        fallback_page_size = max(1, int(library_settings.get("section_page_size") or plex.MAX_SECTION_PAGE_SIZE))
    except Exception:
        fallback_page_size = plex.MAX_SECTION_PAGE_SIZE

    chunk_size = fallback_page_size
    if page_size is not None:
        try:
            chunk_size = max(1, min(int(page_size), plex.MAX_SECTION_PAGE_SIZE))
        except (TypeError, ValueError):
            pass

    detail_defaults = detail_params or {
        "width": "600",
        "height": "900",
        "min": "1",
        "upscale": "1",
    }
    thumb_width, thumb_height, _thumb_quality = plex._thumbnail_config()

    unique_paths: set[str] = set()
    items_processed = 0
    offset = 0
    total_available: Optional[int] = None

    try:
        while True:
            payload = plex.section_items(
                section_id,
                offset=offset,
                limit=chunk_size,
                force_refresh=False,
                snapshot_merge=False,
                prefer_cache=True,
            )
            items = payload.get("items") or []
            if not items:
                break

            for item in items:
                items_processed += 1
                for path in plex._collect_item_image_paths(item):
                    if path not in unique_paths:
                        unique_paths.add(path)

                if max_items is not None and items_processed >= max_items:
                    break

            pagination = payload.get("pagination") or {}
            size = pagination.get("size")
            if not isinstance(size, int) or size <= 0:
                size = len(items)
            offset += size
            total_candidate = pagination.get("total")
            if isinstance(total_candidate, int) and total_candidate >= 0:
                total_available = total_candidate
            if (max_items is not None and items_processed >= max_items) or (
                isinstance(total_available, int) and total_available > 0 and offset >= total_available
            ):
                break

        summary["processed_items"] = items_processed
        summary["unique_original"] = len(unique_paths)
        summary["unique_grid"] = sum(1 for path in unique_paths if not plex._is_art_image(path))

        if not unique_paths:
            return summary

    except PlexServiceError as exc:
        logger.warning(
            "Section image caching failed (section=%s). Retrying: %s",
            section_id,
            exc,
        )
        raise self.retry(exc=exc)
    except Exception as exc:
        logger.exception("Unexpected failure building image cache plan for section=%s", section_id)
        raise self.retry(exc=exc)

    child_results = []
    for path in unique_paths:
        async_result = cache_single_image_task.s(
            section_id=str(section_id),
            path=path,
            detail_params=detail_defaults,
            force=force,
        ).set(queue=IMAGE_CACHE_QUEUE).apply_async()
        child_results.append(async_result)

    child_ids = [str(result.id) for result in child_results if result and result.id]
    summary["children"] = child_ids
    summary["enqueued"] = len(child_results)

    if redis_service and redis_service.available and self.request.id:
        try:
            redis_service.cache_set(
                "celery.image_cache.children",
                self.request.id,
                {"children": child_ids, "timestamp": datetime.now(timezone.utc).isoformat()},
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("Failed to record child tasks for %s: %s", self.request.id, exc)

    results: list[Dict[str, Any]] = []
    try:
        for result in child_results:
            try:
                payload = result.get(disable_sync_subtasks=False, propagate=False)
                if isinstance(payload, Mapping):
                    results.append(dict(payload))
            except Exception as exc:  # pragma: no cover - child failures recorded separately
                logger.debug("Image cache child task failed for section=%s: %s", section_id, exc)
    finally:
        if redis_service and redis_service.available and self.request.id:
            try:
                redis_service.cache_delete("celery.image_cache.children", self.request.id)
            except Exception:  # pragma: no cover - defensive
                pass

    downloads = 0
    skips = 0
    grids = 0
    errors: list[Dict[str, Any]] = []

    if isinstance(results, list):
        for entry in results:
            if not isinstance(entry, Mapping):
                continue
            if entry.get("error"):
                errors.append({"path": entry.get("path"), "error": entry.get("error")})
            if entry.get("fetched"):
                downloads += 1
            else:
                skips += 1
            if entry.get("grid_created"):
                grids += 1

    summary.update(
        {
            "downloads": downloads,
            "skipped": skips,
            "grid_generated": grids,
            "errors": errors,
        }
    )

    logger.info(
        "Cached Plex artwork (section=%s, items=%s, enqueued=%s, downloads=%s, grids=%s, errors=%s)",
        section_id,
        items_processed,
        len(child_ids),
        downloads,
        grids,
        len(errors),
    )

    return summary


def enqueue_section_image_cache(
    *,
    section_id: Any,
    page_size: Optional[int] = None,
    max_items: Optional[int] = None,
    detail_params: Optional[Dict[str, Any]] = None,
    grid_params: Optional[Dict[str, Any]] = None,
    force: bool = False,
) -> Optional[str]:
    """Schedule background caching of Plex artwork for a section."""

    try:
        async_result = cache_section_images_task.delay(
            section_id=section_id,
            page_size=page_size,
            max_items=max_items,
            detail_params=detail_params,
            grid_params=grid_params,
            force=force,
        )
    except Exception as exc:  # pragma: no cover - Celery connectivity
        broker_url = getattr(cache_section_images_task.app.conf, "broker_url", None)
        logger.warning(
            "Unable to enqueue section image caching for %s: %s (broker=%s)",
            section_id,
            exc,
            broker_url,
        )
        return None
    return async_result.id


__all__ = [
    "refresh_plex_sections_snapshot",
    "enqueue_sections_snapshot_refresh",
    "fetch_section_snapshot_chunk",
    "build_section_snapshot_task",
    "enqueue_section_snapshot_build",
    "cache_single_image_task",
    "cache_section_images_task",
    "enqueue_section_image_cache",
]
