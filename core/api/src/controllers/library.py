"""Library browsing endpoints backed by Plex."""
from __future__ import annotations

import logging
from http import HTTPStatus
from typing import Any

from flask import Blueprint, Response, current_app, jsonify, request, stream_with_context
from flask_login import current_user, login_required

from ..services import PlaybackCoordinator, PlaybackCoordinatorError, QueueService
from ..services.plex_service import PlexNotConnectedError, PlexService, PlexServiceError
from ..services.playback_state import PlaybackState
from ..tasks.library import enqueue_section_image_cache, enqueue_section_snapshot_build

LIBRARY_BLUEPRINT = Blueprint("library", __name__, url_prefix="/library")

logger = logging.getLogger(__name__)


def _plex_service() -> PlexService:
    svc: PlexService = current_app.extensions["plex_service"]
    return svc


def _playback_coordinator() -> PlaybackCoordinator:
    coordinator: PlaybackCoordinator = current_app.extensions["playback_coordinator"]
    return coordinator


def _playback_state() -> PlaybackState:
    playback: PlaybackState = current_app.extensions["playback_state"]
    return playback


def _queue_service() -> QueueService:
    queue: QueueService = current_app.extensions["queue_service"]
    return queue


def _ensure_celery_bound() -> None:
    if not current_app:
        return
    if current_app.extensions.get("celery_app") is not None:
        return
    from ..celery_app import init_celery

    init_celery(current_app)


@LIBRARY_BLUEPRINT.get("/plex/sections")
@login_required
def list_sections() -> Any:
    plex = _plex_service()
    logger.info(
        "API request: list Plex sections (user=%s, remote=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
    )
    try:
        payload = plex.list_sections()
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(payload)


@LIBRARY_BLUEPRINT.get("/plex/search")
@login_required
def search_items() -> Any:
    plex = _plex_service()

    raw_query = request.args.get("query") or request.args.get("q") or ""
    query = raw_query.strip()
    try:
        offset = int(request.args.get("offset", 0))
    except ValueError:
        offset = 0
    try:
        limit = int(request.args.get("limit", 60))
    except ValueError:
        limit = 60

    logger.info(
        "API request: search Plex libraries (user=%s, remote=%s, query=%r, offset=%s, limit=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        query,
        offset,
        limit,
    )

    if not query:
        return jsonify(
            {
                "query": "",
                "items": [],
                "pagination": {
                    "offset": 0,
                    "limit": limit,
                    "total": 0,
                    "size": 0,
                },
            }
        )

    try:
        payload = plex.search(query, offset=offset, limit=limit)
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(payload)


@LIBRARY_BLUEPRINT.get("/plex/sections/<section_id>/collections")
@login_required
def section_collections(section_id: str) -> Any:
    plex = _plex_service()

    try:
        offset = int(request.args.get("offset", 0))
    except ValueError:
        offset = 0
    try:
        limit = int(request.args.get("limit", 60))
    except ValueError:
        limit = 60

    logger.info(
        "API request: list Plex collections (user=%s, remote=%s, section=%s, offset=%s, limit=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        section_id,
        offset,
        limit,
    )

    try:
        payload = plex.section_collections(section_id, offset=offset, limit=limit)
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(payload)


@LIBRARY_BLUEPRINT.get("/plex/sections/<section_id>/items")
@login_required
def section_items(section_id: str) -> Any:
    plex = _plex_service()

    sort = request.args.get("sort")
    letter = request.args.get("letter")
    search = request.args.get("search")
    watch_state = request.args.get("watch")
    genre = request.args.get("genre")
    collection = request.args.get("collection")
    year = request.args.get("year")
    try:
        offset = int(request.args.get("offset", 0))
    except ValueError:
        offset = 0
    try:
        limit = int(request.args.get("limit", 60))
    except ValueError:
        limit = 60

    request_params = {
        "sort": sort,
        "letter": letter,
        "search": search,
        "watch": watch_state,
        "genre": genre,
        "collection": collection,
        "year": year,
        "offset": offset,
        "limit": limit,
    }

    raw_snapshot = request.args.get("snapshot")
    if raw_snapshot is None:
        snapshot_merge = False
        request_params["snapshot"] = None
    else:
        normalized_snapshot = str(raw_snapshot).strip().lower()
        snapshot_merge = normalized_snapshot not in {"", "0", "false", "no"}
        request_params["snapshot"] = normalized_snapshot

    logger.info(
        "API request: list Plex section items (user=%s, remote=%s, section=%s, params=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        section_id,
        request_params,
    )

    try:
        payload = plex.section_items(
            section_id,
            sort=sort,
            letter=letter,
            search=search,
            watch_state=watch_state,
            genre=genre,
            collection=collection,
            year=year,
            offset=offset,
            limit=limit,
            snapshot_merge=snapshot_merge,
        )
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(payload)


@LIBRARY_BLUEPRINT.post("/plex/sections/<section_id>/items/refresh")
@login_required
def refresh_section_items(section_id: str) -> Any:
    plex = _plex_service()

    body = request.get_json(silent=True) or {}
    sort = body.get("sort")
    letter = body.get("letter")
    search = body.get("search")
    watch_state = body.get("watch") or body.get("watch_state")
    genre = body.get("genre")
    collection = body.get("collection")
    year = body.get("year")
    try:
        offset = int(body.get("offset", 0))
    except (TypeError, ValueError):
        offset = 0
    try:
        limit = int(body.get("limit", 60))
    except (TypeError, ValueError):
        limit = 60

    request_params = {
        "sort": sort,
        "letter": letter,
        "search": search,
        "watch": watch_state,
        "genre": genre,
        "collection": collection,
        "year": year,
        "offset": offset,
        "limit": limit,
    }

    raw_snapshot = body.get("snapshot")
    if raw_snapshot is None:
        snapshot_merge = False
        request_params["snapshot"] = None
    else:
        normalized_snapshot = str(raw_snapshot).strip().lower()
        snapshot_merge = normalized_snapshot not in {"", "0", "false", "no"}
        request_params["snapshot"] = normalized_snapshot

    logger.info(
        "API request: refresh Plex section items (user=%s, remote=%s, section=%s, params=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        section_id,
        request_params,
    )

    try:
        payload = plex.refresh_section_items(
            section_id,
            sort=sort,
            letter=letter,
            search=search,
            watch_state=watch_state,
            genre=genre,
            collection=collection,
            year=year,
            offset=offset,
            limit=limit,
            snapshot_merge=snapshot_merge,
        )
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(payload)


@LIBRARY_BLUEPRINT.get("/plex/sections/<section_id>/snapshot")
@login_required
def get_section_snapshot(section_id: str) -> Any:
    plex = _plex_service()

    include_items_param = request.args.get("include_items")
    include_items = False
    if include_items_param is not None:
        normalized = str(include_items_param).strip().lower()
        include_items = normalized not in {"", "0", "false", "no"}
    max_items_param = request.args.get("max_items")
    try:
        max_items = int(max_items_param) if max_items_param is not None else None
    except (TypeError, ValueError):
        max_items = None

    try:
        snapshot = plex.get_section_snapshot(
            section_id,
            include_items=include_items,
            max_items=max_items,
        )
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(snapshot)


@LIBRARY_BLUEPRINT.post("/plex/sections/<section_id>/snapshot/build")
@login_required
def build_section_snapshot(section_id: str) -> Any:
    plex = _plex_service()

    body = request.get_json(silent=True) or {}
    sort = body.get("sort")
    try:
        page_size = int(body.get("page_size", 0))
    except (TypeError, ValueError):
        page_size = None
    try:
        max_items = int(body.get("max_items", 0)) if body.get("max_items") is not None else None
    except (TypeError, ValueError):
        max_items = None

    raw_reset = body.get("reset")
    if raw_reset is None:
        reason = str(body.get("reason") or "").strip().lower()
        reset = reason in {"manual", "refresh"}
    else:
        normalized_reset = str(raw_reset).strip().lower()
        reset = normalized_reset not in {"", "0", "false", "no"}

    logger.info(
        "API request: build section snapshot (user=%s, remote=%s, section=%s, sort=%s, page_size=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        section_id,
        sort,
        page_size,
    )

    try:
        parallelism_raw = body.get("parallelism")
        parallelism = int(parallelism_raw) if parallelism_raw is not None else None
    except (TypeError, ValueError):
        parallelism = None

    use_async = body.get("async", True)
    logger.debug(
        "Section snapshot build parameters (section=%s, parallelism=%s, async=%s)",
        section_id,
        parallelism,
        use_async,
    )
    if use_async:
        _ensure_celery_bound()
        task_id = enqueue_section_snapshot_build(
            section_id=section_id,
            sort=sort,
            page_size=page_size,
            max_items=max_items,
            parallelism=parallelism,
            reset=reset,
        )
        if task_id:
            return (
                jsonify({"status": "queued", "task_id": task_id}),
                HTTPStatus.ACCEPTED,
            )

    try:
        snapshot = plex.build_section_snapshot(
            section_id,
            sort=sort,
            page_size=page_size,
            max_items=max_items,
            parallelism=parallelism,
        )
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(snapshot)


@LIBRARY_BLUEPRINT.post("/plex/sections/<section_id>/images")
@login_required
def cache_section_images(section_id: str) -> Any:
    plex = _plex_service()
    body = request.get_json(silent=True) or {}

    try:
        page_size_raw = body.get("page_size")
        page_size = int(page_size_raw) if page_size_raw is not None else None
    except (TypeError, ValueError):
        page_size = None

    try:
        max_items_raw = body.get("max_items")
        max_items = int(max_items_raw) if max_items_raw is not None else None
    except (TypeError, ValueError):
        max_items = None

    detail_params = body.get("detail_params") if isinstance(body.get("detail_params"), dict) else None
    grid_params = body.get("grid_params") if isinstance(body.get("grid_params"), dict) else None

    force_raw = body.get("force")
    force = False
    if force_raw is not None:
        force = str(force_raw).strip().lower() not in {"", "0", "false", "no"}

    use_async = bool(body.get("async", True))

    logger.info(
        "API request: cache section images (user=%s, remote=%s, section=%s, async=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        section_id,
        use_async,
    )

    if use_async:
        _ensure_celery_bound()
        task_id = enqueue_section_image_cache(
            section_id=section_id,
            page_size=page_size,
            max_items=max_items,
            detail_params=detail_params,
            grid_params=grid_params,
            force=force,
        )
        if task_id:
            return jsonify({"status": "queued", "task_id": task_id}), HTTPStatus.ACCEPTED
        return (
            jsonify({"error": "Unable to enqueue section image caching."}),
            HTTPStatus.SERVICE_UNAVAILABLE,
        )

    try:
        summary = plex.cache_section_images(
            section_id,
            page_size=page_size,
            max_items=max_items,
            detail_params=detail_params,
            grid_params=grid_params,
            force=force,
        )
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(summary)


@LIBRARY_BLUEPRINT.get("/plex/items/<rating_key>")
@login_required
def item_details(rating_key: str) -> Any:
    plex = _plex_service()
    logger.info(
        "API request: fetch Plex item details (user=%s, remote=%s, rating_key=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        rating_key,
    )
    try:
        payload = plex.item_details(rating_key)
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.NOT_FOUND
    return jsonify(payload)


@LIBRARY_BLUEPRINT.post("/plex/items/<rating_key>/refresh")
@login_required
def refresh_item_details(rating_key: str) -> Any:
    plex = _plex_service()
    logger.info(
        "API request: refresh Plex item cache (user=%s, remote=%s, rating_key=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        rating_key,
    )
    try:
        payload = plex.refresh_item_details(rating_key)
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.NOT_FOUND
    return jsonify(payload)


@LIBRARY_BLUEPRINT.post("/plex/items/<rating_key>/play")
@login_required
def play_item(rating_key: str) -> Any:
    coordinator = _playback_coordinator()
    queue_service = _queue_service()
    queue_service.disarm()

    body = request.get_json(silent=True) or {}
    part_id = body.get("part_id")

    logger.info(
        "API request: play Plex item (user=%s, remote=%s, rating_key=%s, part_id=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        rating_key,
        part_id,
    )

    try:
        result = coordinator.start_playback(rating_key, part_id=part_id)
    except PlaybackCoordinatorError as exc:
        return jsonify({"error": str(exc)}), exc.status_code

    response_payload = {
        "source": result.source,
        "transcode": result.transcode,
    }
    return jsonify(response_payload), result.status_code


@LIBRARY_BLUEPRINT.get("/plex/image")
@login_required
def proxy_image() -> Response:
    path = request.args.get("path")
    if not path:
        return jsonify({"error": "Missing Plex image path."}), HTTPStatus.BAD_REQUEST

    plex = _plex_service()
    # Preserve all query params except path itself.
    params = {key: value for key, value in request.args.items() if key != "path"}

    try:
        upstream = plex.fetch_image(path, params)
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    logger.info(
        "API request: proxy Plex image (user=%s, remote=%s, path=%s, params=%s, status=%s, cache=%s)",
        getattr(current_user, "id", None),
        request.remote_addr,
        path,
        params,
        upstream.status_code,
        getattr(upstream, "cache_status", "unknown"),
    )

    def generate() -> Any:
        try:
            for chunk in upstream.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    headers = {
        key: value
        for key, value in upstream.headers.items()
        if value and key in {"Content-Type", "Content-Length", "Cache-Control", "ETag", "Last-Modified", "Expires"}
    }
    headers.setdefault("Cache-Control", "public, max-age=86400")

    return Response(stream_with_context(generate()), status=upstream.status_code, headers=headers)


__all__ = ["LIBRARY_BLUEPRINT"]
