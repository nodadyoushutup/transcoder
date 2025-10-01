"""Viewer registration and listing endpoints."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, Dict

from flask import Blueprint, current_app, jsonify, request, session
from flask_login import current_user

from ..services.viewer_service import ViewerService

VIEWERS_BLUEPRINT = Blueprint("viewers", __name__, url_prefix="/viewers")


def _service() -> ViewerService:
    svc: ViewerService = current_app.extensions["viewer_service"]
    return svc


def _resolve_guest_name() -> str:
    guest_name = session.get("guest_name")
    if not guest_name:
        guest_name = ViewerService.generate_guest_name()
        session["guest_name"] = guest_name
    return str(guest_name)


def _build_viewer_payload(record) -> Dict[str, Any]:
    return {
        "token": record.token,
        "display_name": record.username,
        "kind": "guest" if record.is_guest else "user",
        "guest_name": record.username if record.is_guest else None,
    }


@VIEWERS_BLUEPRINT.post("/identify")
def identify_viewer() -> Any:
    payload = request.get_json(silent=True) or {}
    explicit_guest_name = str(payload.get("guest_name", "")).strip() or None

    if current_user.is_authenticated:
        username = current_user.username
        guest_name = None
        user_obj = current_user  # type: ignore[assignment]
    else:
        guest_name = explicit_guest_name or _resolve_guest_name()
        username = guest_name
        user_obj = None

    existing_token = session.get("viewer_token") or None
    record = _service().register(user=user_obj, username=username, token=existing_token)
    session["viewer_token"] = record.token
    session.modified = True

    response: Dict[str, Any] = {
        "viewer": _build_viewer_payload(record),
        "user": current_user.to_public_dict() if current_user.is_authenticated else None,
    }
    if guest_name:
        response["guest"] = {"name": guest_name}
    return jsonify(response), HTTPStatus.OK


@VIEWERS_BLUEPRINT.post("/heartbeat")
def heartbeat() -> Any:
    payload = request.get_json(silent=True) or {}
    token = str(payload.get("token", "")).strip()
    if not token:
        return jsonify({"error": "token required"}), HTTPStatus.BAD_REQUEST

    session_token = session.get("viewer_token") or None
    if session_token and session_token != token:
        session["viewer_token"] = token
        session.modified = True

    if current_user.is_authenticated:
        username = current_user.username
        user_obj = current_user  # type: ignore[assignment]
    else:
        username = _resolve_guest_name()
        user_obj = None

    record = _service().heartbeat(token, user=user_obj, username=username)
    if not record:
        record = _service().register(user=user_obj, username=username, token=token)
    return jsonify({"viewer": _build_viewer_payload(record)}), HTTPStatus.OK


@VIEWERS_BLUEPRINT.get("/list")
def list_viewers() -> Any:
    active = _service().list_active()
    return jsonify(active), HTTPStatus.OK


__all__ = ["VIEWERS_BLUEPRINT"]
