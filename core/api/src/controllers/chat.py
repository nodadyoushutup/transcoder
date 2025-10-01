"""Chat message routes and socket broadcasting."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, Dict, Optional

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..extensions import socketio
from ..models import ChatMessage
from ..services import ChatService


CHAT_BLUEPRINT = Blueprint("chat", __name__, url_prefix="/chat")


def _service() -> ChatService:
    svc: ChatService = current_app.extensions["chat_service"]
    return svc


def _serialize_messages(messages: list[ChatMessage]) -> list[Dict[str, Any]]:
    return [message.to_dict() for message in messages]


@CHAT_BLUEPRINT.get("/messages")
def list_messages() -> Any:
    limit = request.args.get("limit", default=50, type=int)
    before_id = request.args.get("before_id", default=None, type=int)
    limit = max(1, min(limit, 100))
    records, has_more = _service().fetch_messages(limit=limit, before_id=before_id)
    serialized = _serialize_messages(records)
    next_before_id: Optional[int]
    if records and has_more:
        next_before_id = int(records[0].id)
    else:
        next_before_id = None
    payload: Dict[str, Any] = {
        "messages": serialized,
        "next_before_id": next_before_id,
        "has_more": has_more,
    }
    return jsonify(payload), HTTPStatus.OK


@CHAT_BLUEPRINT.route("/messages", methods=["POST", "OPTIONS"])
def post_message() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    if not current_user.is_authenticated:
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED

    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body", "")).strip()
    if not body:
        return jsonify({"error": "message body required"}), HTTPStatus.BAD_REQUEST
    if len(body) > 4_096:
        return (
            jsonify({"error": "message too long"}),
            HTTPStatus.BAD_REQUEST,
        )

    message = _service().create_message(user=current_user, body=body)
    message_dict = message.to_dict()
    socketio.emit("chat:message", message_dict)
    return jsonify({"message": message_dict}), HTTPStatus.CREATED


__all__ = ["CHAT_BLUEPRINT"]


@socketio.on("connect")
def handle_socket_connect():  # pragma: no cover - socketio callback
    current_app.logger.info("Client connected to socket")


@socketio.on("disconnect")
def handle_socket_disconnect():  # pragma: no cover - socketio callback
    current_app.logger.info("Client disconnected from socket")
