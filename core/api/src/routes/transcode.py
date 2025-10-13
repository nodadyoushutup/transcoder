"""Transcode orchestration routes for the backend service."""
from __future__ import annotations

import copy
import logging
from collections.abc import Mapping
from http import HTTPStatus
from typing import Any, MutableMapping, Optional, Tuple

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..app.logging import current_log_file
from ..services import (
    PlaybackCoordinator,
    PlaybackCoordinatorError,
    QueueError,
    QueueService,
    SettingsService,
)
from ..services.playback_state import PlaybackState
from ..services.transcoder_client import TranscoderClient, TranscoderServiceError
from ..services.transcoder_status import TranscoderStatusService

api_bp = Blueprint("api", __name__)
LOGGER = logging.getLogger(__name__)


def _client() -> TranscoderClient:
    client: TranscoderClient = current_app.extensions["transcoder_client"]
    return client


def _status_service() -> TranscoderStatusService:
    service: TranscoderStatusService = current_app.extensions["transcoder_status_service"]
    return service


def _playback_state() -> PlaybackState:
    playback: PlaybackState = current_app.extensions["playback_state"]
    return playback


def _playback_coordinator() -> PlaybackCoordinator:
    coordinator: PlaybackCoordinator = current_app.extensions["playback_coordinator"]
    return coordinator


def _queue_service() -> QueueService:
    queue: QueueService = current_app.extensions["queue_service"]
    return queue


def _settings_service() -> SettingsService:
    svc: SettingsService = current_app.extensions["settings_service"]
    return svc


def _proxy_response(result: Tuple[int, Optional[MutableMapping[str, Any]]]) -> Any:
    status_code, payload = result
    if payload is None:
        return (
            jsonify({"error": "invalid response from transcoder service"}),
            HTTPStatus.BAD_GATEWAY,
        )
    return jsonify(payload), status_code


def _extract_session(payload: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {}
    session = payload.get("session")
    if isinstance(session, Mapping):
        session_dict = dict(session)
    else:
        session_dict = {}
    return session_dict


def _extract_metadata(payload: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {}
    metadata = payload.get("metadata")
    if isinstance(metadata, Mapping):
        return copy.deepcopy(metadata)

    details = payload.get("details") if isinstance(payload.get("details"), Mapping) else None
    item = payload.get("item") if isinstance(payload.get("item"), Mapping) else None
    source = payload.get("source_metadata")
    if not isinstance(source, Mapping):
        source = payload.get("source") if isinstance(payload.get("source"), Mapping) else None

    metadata_dict: dict[str, Any] = {}
    if "rating_key" in payload:
        metadata_dict["rating_key"] = payload.get("rating_key")
    if "library_section_id" in payload:
        metadata_dict["library_section_id"] = payload.get("library_section_id")
    if item:
        metadata_dict["item"] = copy.deepcopy(item)
    if details:
        metadata_dict["details"] = copy.deepcopy(details)
    if source:
        metadata_dict["source"] = copy.deepcopy(source)
    return metadata_dict


def _build_status_response(
    status_payload: Optional[Mapping[str, Any]],
    playback_snapshot: Optional[Mapping[str, Any]],
    redis_info: Mapping[str, Any],
) -> dict[str, Any]:
    session = _extract_session(status_payload)
    metadata = _extract_metadata(status_payload)

    playback = playback_snapshot if isinstance(playback_snapshot, Mapping) else None
    if playback:
        rating_key = playback.get("rating_key")
        if rating_key is not None:
            metadata.setdefault("rating_key", rating_key)
            session.setdefault("rating_key", rating_key)

        library_section_id = playback.get("library_section_id")
        if library_section_id is not None:
            metadata.setdefault("library_section_id", library_section_id)

        item_payload = playback.get("item") if isinstance(playback.get("item"), Mapping) else None
        if item_payload:
            metadata.setdefault("item", copy.deepcopy(item_payload))

        details_payload = playback.get("details") if isinstance(playback.get("details"), Mapping) else None
        if details_payload:
            metadata.setdefault("details", copy.deepcopy(details_payload))

        source_payload = playback.get("source") if isinstance(playback.get("source"), Mapping) else None
        if source_payload:
            metadata.setdefault("source", copy.deepcopy(source_payload))

        started_at = playback.get("started_at")
        if started_at and not session.get("started_at"):
            session["started_at"] = started_at
        updated_at = playback.get("updated_at")
        if updated_at and not session.get("updated_at"):
            session["updated_at"] = updated_at

        playback_session_id = playback.get("session_id")
        if playback_session_id and not session.get("session_id"):
            session["session_id"] = playback_session_id

    return {
        "session": session,
        "metadata": metadata,
        "redis": copy.deepcopy(dict(redis_info)),
    }


def _extract_running_state(payload: Optional[Mapping[str, Any]]) -> Optional[bool]:
    if not isinstance(payload, Mapping):
        return None
    session = payload.get("session") if isinstance(payload.get("session"), Mapping) else None
    if isinstance(session, Mapping):
        running = session.get("running")
    else:
        running = payload.get("running")
    if running is None:
        return None
    return bool(running)


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
    status_service = _status_service()
    try:
        status_code, payload = status_service.status()
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE

    redis_service = current_app.extensions.get("redis_service")
    snapshot = redis_service.snapshot() if redis_service else {"available": False}
    redis_info: Mapping[str, Any] = snapshot if isinstance(snapshot, Mapping) else {"available": False}

    playback_state = _playback_state()

    def prepare_response(status_payload: Optional[Mapping[str, Any]]) -> tuple[Optional[bool], dict[str, Any]]:
        running_flag = _extract_running_state(status_payload)
        LOGGER.info("/transcode/status raw running=%s", running_flag)
        snapshot_payload = playback_state.snapshot()
        if running_flag is not None:
            _previous_running, has_seen_running = playback_state.update_transcoder_running(running_flag)
            if not running_flag and has_seen_running and snapshot_payload:
                playback_state.clear()
                snapshot_payload = None
        response = _build_status_response(status_payload, snapshot_payload, redis_info)
        return running_flag, response

    _running_flag, response_payload = prepare_response(payload)

    queue_service = _queue_service()
    try:
        progressed = queue_service.ensure_progress(response_payload)
    except QueueError as exc:
        LOGGER.error("Queue advance failed: %s", exc)
        progressed = None
    LOGGER.info(
        "/transcode/status queue.ensure_progress progressed=%s session_id=%s",
        progressed,
        response_payload.get("session", {}).get("session_id"),
    )

    if response_payload["session"].get("running"):
        playback_state.touch()
    elif progressed is not None:
        try:
            status_code, payload = status_service.status()
        except TranscoderServiceError:
            return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE
        _running_flag, response_payload = prepare_response(payload)

    queue_state = queue_service.auto_advance_state()
    LOGGER.info("/transcode/status queue_state=%s", queue_state)
    session_block = response_payload.setdefault("session", {})
    if session_block.get("session_id") is None and session_block.get("id") is not None:
        session_block["session_id"] = session_block.get("id")
    if session_block.get("session_id") is None and queue_state.get("session_id") is not None:
        session_block["session_id"] = queue_state.get("session_id")
    session_block["queue_auto_advance"] = queue_state

    return _proxy_response((status_code, response_payload))


@api_bp.get("/player/settings")
def player_settings() -> Any:
    svc = _settings_service()
    settings = svc.get_sanitized_player_settings()
    defaults = svc.sanitize_player_settings(
        svc.system_defaults(SettingsService.PLAYER_NAMESPACE)
    )
    return jsonify({"settings": settings, "defaults": defaults}), HTTPStatus.OK


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


@api_bp.get("/transcode/tasks/<string:task_id>")
def get_transcode_task(task_id: str) -> Any:
    try:
        return _proxy_response(_client().task_status(task_id))
    except TranscoderServiceError:
        return jsonify({"error": "transcoder service unavailable"}), HTTPStatus.SERVICE_UNAVAILABLE


__all__ = ["api_bp"]
