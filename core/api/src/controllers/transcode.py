"""Transcode orchestration routes for the backend service."""
from __future__ import annotations

import logging
from http import HTTPStatus
from typing import Any, MutableMapping, Optional, Tuple

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..logging_config import current_log_file
from ..services import PlaybackCoordinator, PlaybackCoordinatorError, QueueError, QueueService
from ..services.playback_state import PlaybackState
from ..services.transcoder_client import TranscoderClient, TranscoderServiceError

api_bp = Blueprint("api", __name__)
LOGGER = logging.getLogger(__name__)


def _client() -> TranscoderClient:
    client: TranscoderClient = current_app.extensions["transcoder_client"]
    return client


def _playback_state() -> PlaybackState:
    playback: PlaybackState = current_app.extensions["playback_state"]
    return playback


def _playback_coordinator() -> PlaybackCoordinator:
    coordinator: PlaybackCoordinator = current_app.extensions["playback_coordinator"]
    return coordinator


def _queue_service() -> QueueService:
    queue: QueueService = current_app.extensions["queue_service"]
    return queue


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
    else:
        queue_service = _queue_service()
        try:
            progressed = queue_service.ensure_progress(payload)
        except QueueError as exc:
            LOGGER.error("Queue advance failed: %s", exc)
            progressed = None
        if progressed is not None:
            try:
                status_code, payload = _client().status()
            except TranscoderServiceError:
                return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE

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
    finally:
        _queue_service().disarm()


@api_bp.route("/transcode/stop", methods=["POST", "OPTIONS"])
def stop_transcode() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    if not current_user.is_authenticated:
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED
    coordinator = _playback_coordinator()
    queue_service = _queue_service()
    queue_service.disarm()
    try:
        status_code, payload = coordinator.stop_playback()
    except PlaybackCoordinatorError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    return _proxy_response((status_code, payload))


__all__ = ["api_bp"]
