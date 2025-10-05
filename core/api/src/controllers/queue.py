"""Queue management endpoints."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, Mapping

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_required

from ..services import QueueError, QueueService
from ..services.transcoder_client import TranscoderServiceError
from ..services.transcoder_status import TranscoderStatusService

QUEUE_BLUEPRINT = Blueprint("queue", __name__, url_prefix="/queue")


def _queue_service() -> QueueService:
    queue: QueueService = current_app.extensions["queue_service"]
    return queue


def _transcoder_status_service() -> TranscoderStatusService:
    service: TranscoderStatusService = current_app.extensions["transcoder_status_service"]
    return service


def _queue_snapshot() -> Mapping[str, Any]:
    return _queue_service().snapshot()


@QUEUE_BLUEPRINT.get("")
@login_required
def get_queue() -> Any:
    return jsonify(_queue_snapshot())


@QUEUE_BLUEPRINT.post("/items")
@login_required
def add_queue_item() -> Any:
    payload = request.get_json(silent=True) or {}
    rating_key = payload.get("rating_key")
    if not rating_key:
        return jsonify({"error": "rating_key is required"}), HTTPStatus.BAD_REQUEST
    part_id = payload.get("part_id")
    mode = (payload.get("mode") or "last").lower()
    index_value = payload.get("index")
    try:
        index = int(index_value) if index_value is not None else None
    except (TypeError, ValueError):
        index = None
    queue = _queue_service()
    try:
        item = queue.enqueue(
            rating_key=rating_key,
            part_id=part_id,
            mode=mode,
            index=index,
            requested_by=current_user if current_user.is_authenticated else None,
        )
    except QueueError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    snapshot = _queue_snapshot()
    return jsonify({"item": item, "queue": snapshot}), HTTPStatus.CREATED


@QUEUE_BLUEPRINT.patch("/items/<int:item_id>/move")
@login_required
def move_queue_item(item_id: int) -> Any:
    payload = request.get_json(silent=True) or {}
    direction = (payload.get("direction") or "").lower()
    if direction not in {"up", "down"}:
        return jsonify({"error": "direction must be 'up' or 'down'"}), HTTPStatus.BAD_REQUEST
    queue = _queue_service()
    try:
        moved = queue.move_item(item_id, direction)
    except QueueError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    if not moved:
        return jsonify({"error": "unable to move queue item"}), HTTPStatus.BAD_REQUEST
    return jsonify(_queue_snapshot())


@QUEUE_BLUEPRINT.delete("/items/<int:item_id>")
@login_required
def delete_queue_item(item_id: int) -> Any:
    queue = _queue_service()
    removed = queue.remove_item(item_id)
    if not removed:
        return jsonify({"error": "queue item not found"}), HTTPStatus.NOT_FOUND
    return jsonify(_queue_snapshot())


@QUEUE_BLUEPRINT.post("/play")
@login_required
def play_queue() -> Any:
    queue = _queue_service()
    queue.arm()
    status_service = _transcoder_status_service()
    try:
        status_code, payload = status_service.status()
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE
    if payload is not None and payload.get("running"):
        return jsonify(_queue_snapshot())
    try:
        queue.ensure_progress(payload)
    except QueueError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    return jsonify(_queue_snapshot())


@QUEUE_BLUEPRINT.post("/skip")
@login_required
def skip_queue_item() -> Any:
    queue = _queue_service()
    queue.arm()
    try:
        queue.skip_current()
    except QueueError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    return jsonify(_queue_snapshot())


__all__ = ["QUEUE_BLUEPRINT"]
