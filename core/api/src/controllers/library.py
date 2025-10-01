"""Library browsing endpoints backed by Plex."""
from __future__ import annotations

import re
from http import HTTPStatus
from typing import Any, Dict

from flask import Blueprint, Response, current_app, jsonify, request, stream_with_context
from flask_login import login_required

from ..services.plex_service import PlexNotConnectedError, PlexService, PlexServiceError
from ..services.transcoder_client import TranscoderClient, TranscoderServiceError

LIBRARY_BLUEPRINT = Blueprint("library", __name__, url_prefix="/library")

_SLUG_PATTERN = re.compile(r"[^a-z0-9]+")


def _plex_service() -> PlexService:
    svc: PlexService = current_app.extensions["plex_service"]
    return svc


def _transcoder_client() -> TranscoderClient:
    client: TranscoderClient = current_app.extensions["transcoder_client"]
    return client


def _slugify(value: str, rating_key: str | int | None = None) -> str:
    if not value:
        base = "plex-media"
    else:
        base = _SLUG_PATTERN.sub("-", value.lower()).strip("-")
        if not base:
            base = "plex-media"
    if rating_key is not None:
        base = f"{base}-{rating_key}"
    return base[:80]


@LIBRARY_BLUEPRINT.get("/plex/sections")
@login_required
def list_sections() -> Any:
    plex = _plex_service()
    try:
        payload = plex.list_sections()
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
        )
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(payload)


@LIBRARY_BLUEPRINT.get("/plex/items/<rating_key>")
@login_required
def item_details(rating_key: str) -> Any:
    plex = _plex_service()
    try:
        payload = plex.item_details(rating_key)
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.NOT_FOUND
    return jsonify(payload)


@LIBRARY_BLUEPRINT.post("/plex/items/<rating_key>/play")
@login_required
def play_item(rating_key: str) -> Any:
    plex = _plex_service()
    transcoder = _transcoder_client()

    body = request.get_json(silent=True) or {}
    part_id = body.get("part_id")

    try:
        source = plex.resolve_media_source(rating_key, part_id=part_id)
    except PlexNotConnectedError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
    except PlexServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.NOT_FOUND

    overrides: Dict[str, Any] = {
        "input_path": source["file"],
        "output_basename": _slugify(source["item"].get("title"), rating_key),
        "realtime_input": True,
    }

    if source.get("media_type") == "audio":
        overrides["max_video_tracks"] = 0
        overrides.setdefault("max_audio_tracks", 1)
    else:
        overrides.setdefault("max_video_tracks", 1)
        overrides.setdefault("max_audio_tracks", 1)

    try:
        status_code, payload = transcoder.start(overrides)
    except TranscoderServiceError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    response_payload = {
        "source": source,
        "transcode": payload,
    }

    if payload is None:
        return jsonify({"error": "Invalid response from transcoder service."}), HTTPStatus.BAD_GATEWAY

    return jsonify(response_payload), status_code


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

    def generate() -> Any:
        try:
            for chunk in upstream.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    headers = {}
    for header in ("Content-Type", "Content-Length", "Cache-Control", "ETag", "Last-Modified", "Expires"):
        value = upstream.headers.get(header)
        if value:
            headers[header] = value

    headers.setdefault("Cache-Control", "public, max-age=86400")

    return Response(stream_with_context(generate()), status=upstream.status_code, headers=headers)


__all__ = ["LIBRARY_BLUEPRINT"]
