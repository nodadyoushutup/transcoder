"""Transcode orchestration routes for the backend service."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, MutableMapping, Optional, Tuple

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..logging_config import current_log_file
from ..services.playback_state import PlaybackState
from ..services.transcoder_client import TranscoderClient, TranscoderServiceError

api_bp = Blueprint("api", __name__)


def _client() -> TranscoderClient:
    client: TranscoderClient = current_app.extensions["transcoder_client"]
    return client


def _playback_state() -> PlaybackState:
    playback: PlaybackState = current_app.extensions["playback_state"]
    return playback


def _proxy_response(result: Tuple[int, Optional[MutableMapping[str, Any]]]) -> Any:
    status_code, payload = result
    if payload is None:
        return (
            jsonify({"error": "invalid response from transcoder service"}),
            HTTPStatus.BAD_GATEWAY,
        )
    return jsonify(payload), status_code


@api_bp.get("/health")
def health() -> Any:
    try:
        result = _client().health()
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE
    status_code, payload = result
    if payload is None:
        return (
            jsonify({"error": "invalid response from transcoder service"}),
            HTTPStatus.BAD_GATEWAY,
        )
    payload.setdefault(
        "backend",
        {"log_file": str(current_log_file()) if current_log_file() else None},
    )
    return jsonify(payload), status_code


@api_bp.get("/transcode/status")
def get_status() -> Any:
    try:
        status_code, payload = _client().status()
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE

    if payload is not None and payload.get("running"):
        _playback_state().touch()

    return _proxy_response((status_code, payload))


@api_bp.get("/transcode/current-item")
def current_item() -> Any:
    snapshot = _playback_state().snapshot()
    if snapshot is None:
        return jsonify({"item": None}), HTTPStatus.OK
    return jsonify(snapshot)


@api_bp.route("/transcode/start", methods=["POST", "OPTIONS"])
def start_transcode() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    if not current_user.is_authenticated:
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED
    body = request.get_json(silent=True) or {}
    try:
        return _proxy_response(_client().start(body))
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE


@api_bp.route("/transcode/stop", methods=["POST", "OPTIONS"])
def stop_transcode() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    if not current_user.is_authenticated:
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED
    try:
        result = _client().stop()
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE

    status_code, _payload = result
    if status_code in (HTTPStatus.OK, HTTPStatus.CONFLICT):
        _playback_state().clear()

    return _proxy_response(result)


__all__ = ["api_bp"]
