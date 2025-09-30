"""Transcode orchestration routes for the backend service."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, MutableMapping, Optional, Tuple

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..logging import current_log_file
from ..services.transcoder_client import TranscoderClient, TranscoderServiceError

api_bp = Blueprint("api", __name__)


def _client() -> TranscoderClient:
    client: TranscoderClient = current_app.extensions["transcoder_client"]
    return client


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
        return _proxy_response(_client().status())
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE


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
        return _proxy_response(_client().stop())
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE


__all__ = ["api_bp"]
