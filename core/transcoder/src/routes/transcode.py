"""HTTP routes that drive the transcoder pipeline."""
from __future__ import annotations

from http import HTTPStatus

from flask import Blueprint, current_app, jsonify, request

from celery.exceptions import TimeoutError as CeleryTimeoutError

from ..celery.tasks import (
    extract_subtitles_task,
    start_transcode_task,
    stop_transcode_task,
)
from ..services.transcode_session import TranscodeSessionService, get_session_service

api_bp = Blueprint("transcoder_api", __name__)


def _service() -> TranscodeSessionService:
    return get_session_service(current_app)


@api_bp.route("/status", methods=["GET"])
def status_endpoint():
    payload = _service().status_payload()
    return jsonify(payload), HTTPStatus.OK


@api_bp.route("/transcode", methods=["POST"])
def transcode_endpoint():
    overrides = request.get_json(silent=True) or {}
    task = start_transcode_task.delay(overrides)
    try:
        result = task.get(timeout=current_app.config["CELERY_TASK_TIMEOUT_SECONDS"])
    except CeleryTimeoutError:
        return jsonify({"status": HTTPStatus.ACCEPTED, "task_id": task.id}), HTTPStatus.ACCEPTED
    return jsonify(result["payload"]), result["status"]


@api_bp.route("/transcode/stop", methods=["POST"])
def stop_transcode_endpoint():
    task = stop_transcode_task.delay()
    try:
        result = task.get(timeout=current_app.config["CELERY_TASK_TIMEOUT_SECONDS"])
    except CeleryTimeoutError:
        return jsonify({"status": HTTPStatus.ACCEPTED, "task_id": task.id}), HTTPStatus.ACCEPTED
    return jsonify(result["payload"]), result["status"]


@api_bp.route("/subtitles/extract", methods=["POST"])
def extract_subtitles_endpoint():
    payload = request.get_json(silent=True) or {}
    task = extract_subtitles_task.delay(payload)
    try:
        result = task.get(timeout=current_app.config["CELERY_TASK_TIMEOUT_SECONDS"])
    except CeleryTimeoutError:
        return jsonify({"status": HTTPStatus.ACCEPTED, "task_id": task.id}), HTTPStatus.ACCEPTED
    return jsonify({"tracks": result.get("tracks", []), "status": result["status"]}), result["status"]


@api_bp.route("/restart", methods=["POST"])
def restart_endpoint():
    service = _service()
    check = service.require_internal_token(request)
    if check is not None:
        return check

    current_app.logger.info("Internal restart requested", extra={"event": "service_restart_requested", "service": "transcoder"})
    service.schedule_restart()
    return jsonify({"status": "restarting"}), HTTPStatus.ACCEPTED


__all__ = [
    "api_bp",
]
