"""HTTP routes that drive the transcoder pipeline."""
from __future__ import annotations

from datetime import datetime, timezone
from http import HTTPStatus
from typing import Any, Mapping

from flask import Blueprint, current_app, jsonify, request

from celery.exceptions import TimeoutError as CeleryTimeoutError
from celery.result import AsyncResult

from ..celery_app import celery
from ..celery_app.tasks import start_transcode_task, stop_transcode_task
from ..services.transcode_session import TranscodeSessionService, get_session_service

api_bp = Blueprint("transcoder_api", __name__)


def _service() -> TranscodeSessionService:
    return get_session_service(current_app)


def _task_timeout_seconds() -> float:
    """Return a positive timeout for Celery task sync calls."""

    raw_value = current_app.config.get("CELERY_TASK_TIMEOUT_SECONDS")
    try:
        timeout = float(raw_value)
    except (TypeError, ValueError):
        current_app.logger.warning(
            "Invalid CELERY_TASK_TIMEOUT_SECONDS=%r; falling back to 10s",
            raw_value,
        )
        timeout = 10.0
    return max(timeout, 0.1)


def _coerce_status_code(value: object, default: HTTPStatus = HTTPStatus.OK) -> int:
    if isinstance(value, HTTPStatus):
        return value.value
    if isinstance(value, int):
        return value
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default.value


def _normalize_task_result(task_name: str, result: Any) -> tuple[int, Any]:
    if isinstance(result, Mapping):
        status_code = _coerce_status_code(result.get("status"), HTTPStatus.OK)
        payload_section = result.get("payload")
        if isinstance(payload_section, Mapping):
            return status_code, dict(payload_section)
        if payload_section is not None:
            return status_code, payload_section
        trimmed = {key: value for key, value in result.items() if key != "status"}
        return status_code, trimmed
    return HTTPStatus.OK.value, result


@api_bp.route("/status", methods=["GET"])
def status_endpoint():
    payload = _service().status_payload()
    return jsonify(payload), HTTPStatus.OK


@api_bp.route("/health", methods=["GET"])
def health_endpoint():
    now = datetime.now(timezone.utc)
    payload = {
        "status": "ok",
        "service": "transcoder",
        "timestamp": now.isoformat(),
        "task_timeout_seconds": _task_timeout_seconds(),
        "queues": {
            "default": current_app.config.get("CELERY_TASK_DEFAULT_QUEUE"),
            "audio_video": current_app.config.get("CELERY_TRANSCODE_AV_QUEUE"),
        },
    }
    return jsonify(payload), HTTPStatus.OK


@api_bp.route("/transcode", methods=["POST"])
def transcode_endpoint():
    overrides = request.get_json(silent=True) or {}
    task = start_transcode_task.delay(overrides)
    try:
        result = task.get(timeout=_task_timeout_seconds())
    except CeleryTimeoutError:
        return jsonify({"status": HTTPStatus.ACCEPTED, "task_id": task.id}), HTTPStatus.ACCEPTED
    return jsonify(result["payload"]), result["status"]


@api_bp.route("/transcode/stop", methods=["POST"])
def stop_transcode_endpoint():
    task = stop_transcode_task.delay()
    try:
        result = task.get(timeout=_task_timeout_seconds())
    except CeleryTimeoutError:
        return jsonify({"status": HTTPStatus.ACCEPTED, "task_id": task.id}), HTTPStatus.ACCEPTED
    return jsonify(result["payload"]), result["status"]

@api_bp.route("/tasks/<string:task_id>", methods=["GET"])
def task_status_endpoint(task_id: str):
    async_result = celery.AsyncResult(task_id)
    payload: dict[str, Any] = {
        "task_id": task_id,
        "state": async_result.state,
        "ready": async_result.ready(),
        "successful": async_result.successful(),
    }

    if async_result.failed():
        error_message = str(async_result.result)
        payload["result"] = error_message
        payload["error"] = error_message
        payload["status"] = HTTPStatus.INTERNAL_SERVER_ERROR.value
        return jsonify(payload), HTTPStatus.INTERNAL_SERVER_ERROR

    if not async_result.ready():
        payload["result"] = None
        payload["status"] = HTTPStatus.ACCEPTED.value
        return jsonify(payload), HTTPStatus.ACCEPTED

    status_code, result_payload = _normalize_task_result(async_result.name or "", async_result.result)
    payload["result"] = result_payload
    payload["status"] = status_code
    return jsonify(payload), HTTPStatus.OK


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
