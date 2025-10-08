"""HTTP routes that drive the transcoder pipeline."""
from __future__ import annotations

import hmac
import os
import signal
import threading
import time
from dataclasses import fields
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from typing import Any, Mapping, Optional

from flask import Blueprint, current_app, jsonify, request

from celery.exceptions import TimeoutError as CeleryTimeoutError

from transcoder import (
    AudioEncodingOptions,
    DashMuxingOptions,
    EncoderSettings,
    VideoEncodingOptions,
)

from ..logging_config import current_log_file
from ..services.controller import TranscoderController
from ..tasks import start_transcode_task, extract_subtitles_task, stop_transcode_task

api_bp = Blueprint("transcoder_api", __name__)


_RESTART_DELAY_SECONDS = 0.75


def _expected_internal_token() -> Optional[str]:
    token = current_app.config.get("TRANSCODER_INTERNAL_TOKEN")
    if isinstance(token, str):
        trimmed = token.strip()
        if trimmed:
            return trimmed
    env_token = os.getenv("TRANSCODER_INTERNAL_TOKEN")
    if isinstance(env_token, str):
        trimmed = env_token.strip()
        if trimmed:
            return trimmed
    return None


def _extract_internal_token() -> Optional[str]:
    auth_header = request.headers.get("Authorization")
    if isinstance(auth_header, str) and auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
        if candidate:
            return candidate
    header = request.headers.get("X-Internal-Token")
    if isinstance(header, str):
        candidate = header.strip()
        if candidate:
            return candidate
    return None


def _require_internal_token() -> Optional[tuple[Any, int]]:
    expected = _expected_internal_token()
    if not expected:
        current_app.logger.warning("Internal restart blocked: token not configured")
        return jsonify({"error": "internal access not configured"}), HTTPStatus.SERVICE_UNAVAILABLE

    provided = _extract_internal_token()
    if not provided:
        return jsonify({"error": "missing token"}), HTTPStatus.UNAUTHORIZED

    if not hmac.compare_digest(provided, expected):
        current_app.logger.warning("Internal restart blocked: invalid token provided")
        return jsonify({"error": "invalid token"}), HTTPStatus.FORBIDDEN

    return None


def _schedule_restart(*, logger) -> None:
    parent_pid = os.getppid()
    target_pid = parent_pid if parent_pid > 1 else os.getpid()

    def _worker(pid: int) -> None:
        time.sleep(_RESTART_DELAY_SECONDS)
        try:
            os.kill(pid, signal.SIGHUP)
            logger.info("Sent SIGHUP to pid %s to trigger restart", pid)
        except OSError as exc:
            logger.warning("Restart via SIGHUP failed for pid %s: %s", pid, exc)
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError as fallback_exc:
                logger.error("SIGTERM fallback failed for pid %s: %s", pid, fallback_exc)

    threading.Thread(target=_worker, args=(target_pid,), daemon=True).start()


def _controller() -> TranscoderController:
    ctrl: TranscoderController = current_app.extensions["transcoder_controller"]
    return ctrl


def _effective_local_media_base(config: Mapping[str, Any]) -> Optional[str]:
    configured = config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    if isinstance(configured, str) and configured.strip():
        return configured.strip().rstrip('/') + '/'
    return None


def _coerce_string_sequence(value: Any) -> Optional[tuple[str, ...]]:
    if value is None:
        return None
    if isinstance(value, (list, tuple, set)):
        return tuple(str(item) for item in value)
    return (str(value),)


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off", ""}:
            return False
    return False


def _component_from_overrides(cls, override: Any) -> Any:
    if not isinstance(override, Mapping):
        return cls()
    valid = {field.name for field in fields(cls)}
    filtered: dict[str, Any] = {}
    for key, value in override.items():
        if key not in valid:
            continue
        if value is None:
            filtered[key] = None
            continue
        if isinstance(value, str) and value.strip() == "":
            filtered[key] = None
            continue
        if cls is DashMuxingOptions and key == "availability_time_offset":
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                continue
            filtered[key] = max(0.0, numeric)
            continue
        filtered[key] = value
    if not filtered:
        return cls()
    return cls(**filtered)


def _build_settings(config: Mapping[str, Any], overrides: Mapping[str, Any]) -> EncoderSettings:
    input_path = overrides.get("input_path") or config["TRANSCODER_INPUT"]
    output_dir = overrides.get("output_dir") or config["TRANSCODER_OUTPUT"]
    output_basename = overrides.get("output_basename") or config["TRANSCODER_OUTPUT_BASENAME"]

    realtime_input = overrides.get("realtime_input")
    copy_timestamps_override = overrides.get("copy_timestamps")
    start_at_zero_override = overrides.get("start_at_zero")
    video_overrides = overrides.get("video")
    audio_overrides = overrides.get("audio")
    dash_overrides = overrides.get("dash")
    session_overrides = overrides.get("session") if isinstance(overrides.get("session"), Mapping) else None
    input_args_override = _coerce_string_sequence(overrides.get("input_args"))
    extra_output_override = _coerce_string_sequence(overrides.get("extra_output_args"))
    ffmpeg_binary = overrides.get("ffmpeg_binary")
    ffprobe_binary = overrides.get("ffprobe_binary")
    overwrite = overrides.get("overwrite")
    max_video_tracks = overrides.get("max_video_tracks")
    max_audio_tracks = overrides.get("max_audio_tracks")
    auto_keyframing_override = overrides.get("auto_keyframing")

    settings_kwargs: dict[str, Any] = {
        "input_path": str(input_path),
        "output_dir": Path(output_dir),
        "output_basename": str(output_basename),
        "realtime_input": True if realtime_input is None else bool(realtime_input),
        "video": _component_from_overrides(VideoEncodingOptions, video_overrides),
        "audio": _component_from_overrides(AudioEncodingOptions, audio_overrides),
        "dash": _component_from_overrides(DashMuxingOptions, dash_overrides),
    }

    if copy_timestamps_override is not None:
        settings_kwargs["copy_timestamps"] = _coerce_bool(copy_timestamps_override)
    if start_at_zero_override is not None:
        settings_kwargs["start_at_zero"] = _coerce_bool(start_at_zero_override)

    if session_overrides:
        session_id = session_overrides.get("id")
        if session_id is not None:
            settings_kwargs["session_id"] = str(session_id)
        segment_prefix = session_overrides.get("segment_prefix")
        if segment_prefix:
            settings_kwargs["session_segment_prefix"] = str(segment_prefix).strip("/")

    if input_args_override is not None:
        settings_kwargs["input_args"] = input_args_override
    if extra_output_override is not None:
        settings_kwargs["extra_output_args"] = extra_output_override
    if ffmpeg_binary:
        settings_kwargs["ffmpeg_binary"] = str(ffmpeg_binary)
    if ffprobe_binary:
        settings_kwargs["ffprobe_binary"] = str(ffprobe_binary)
    if overwrite is not None:
        settings_kwargs["overwrite"] = bool(overwrite)
    if max_video_tracks is not None:
        settings_kwargs["max_video_tracks"] = int(max_video_tracks)
    if max_audio_tracks is not None:
        settings_kwargs["max_audio_tracks"] = int(max_audio_tracks)
    if auto_keyframing_override is not None:
        settings_kwargs["auto_keyframing"] = bool(auto_keyframing_override)

    return EncoderSettings(**settings_kwargs)


def _resolve_publish_base_url(config: Mapping[str, Any], overrides: Mapping[str, Any]) -> Optional[str]:
    candidate = overrides.get("publish_base_url")
    if candidate is None or candidate == "":
        candidate = config.get("TRANSCODER_PUBLISH_BASE_URL")
    if isinstance(candidate, str):
        trimmed = candidate.strip()
        if trimmed:
            if not trimmed.endswith('/'):
                trimmed = f"{trimmed}/"
            return trimmed
    return None


def _status_payload(config: Mapping[str, Any]) -> dict[str, Any]:
    status = _controller().status(local_base_override=_effective_local_media_base(config))
    log_path = current_log_file()
    session = status.to_session(
        log_file=str(log_path) if log_path else None,
        origin="transcoder",
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    return {"session": session, "metadata": {}}


@api_bp.post("/internal/restart")
def internal_restart() -> Any:
    auth_error = _require_internal_token()
    if auth_error:
        return auth_error

    logger = current_app.logger
    logger.info("Internal restart requested", extra={"event": "service_restart_requested", "service": "transcoder"})
    _schedule_restart(logger=logger)
    return jsonify({"status": "scheduled"}), HTTPStatus.ACCEPTED


@api_bp.get("/health")
def health() -> Any:
    config = current_app.config
    status = _status_payload(config)
    session_section = status.setdefault("session", {})
    session_section.setdefault("defaults", {
        "input_path": config["TRANSCODER_INPUT"],
        "output_dir": config["TRANSCODER_OUTPUT"],
        "output_basename": config["TRANSCODER_OUTPUT_BASENAME"],
        "publish_base_url": config.get("TRANSCODER_PUBLISH_BASE_URL"),
        "local_media_base_url": _effective_local_media_base(config),
    })
    return jsonify({"status": "ok", "transcoder": status})


@api_bp.get("/transcode/status")
def get_status() -> Any:
    config = current_app.config
    return jsonify(_status_payload(config))


@api_bp.route("/transcode/start", methods=["POST", "OPTIONS"])
def start_transcode() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    config = current_app.config
    overrides = request.get_json(silent=True) or {}
    try:
        settings = _build_settings(config, overrides)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST

    publish_base_url = _resolve_publish_base_url(config, overrides)
    if not publish_base_url:
        return (
            jsonify({
                "error": "A publish base URL is required. Configure your ingest server's /media endpoint under System Settings → Transcoder.",
                "status": _status_payload(config),
            }),
            HTTPStatus.BAD_REQUEST,
        )
    force_new_connection_override = overrides.get("publish_force_new_connection")
    force_new_connection = None
    if force_new_connection_override is not None:
        force_new_connection = _coerce_bool(force_new_connection_override)
    subtitle_meta = overrides.get("subtitle") if isinstance(overrides.get("subtitle"), Mapping) else None
    task_payload = dict(overrides)
    task_payload["publish_base_url"] = publish_base_url
    if force_new_connection is not None:
        task_payload["force_new_connection"] = force_new_connection
    if subtitle_meta:
        task_payload["subtitle"] = subtitle_meta
    queue_name = config.get("CELERY_TRANSCODE_AV_QUEUE", "transcode_av")
    async_result = start_transcode_task.apply_async(args=(task_payload,), queue=queue_name)
    payload = _status_payload(config)
    return jsonify({"task_id": async_result.id, "status": payload}), HTTPStatus.ACCEPTED


@api_bp.route("/transcode/stop", methods=["POST", "OPTIONS"])
def stop_transcode() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    config = current_app.config
    queue_name = config.get("CELERY_TRANSCODE_AV_QUEUE", "transcode_av")
    timeout_config = config.get("TRANSCODER_STOP_TIMEOUT", 15)
    try:
        timeout_seconds = float(timeout_config)
        if timeout_seconds <= 0:
            raise ValueError
    except (TypeError, ValueError):
        timeout_seconds = 15.0

    async_result = stop_transcode_task.apply_async(queue=queue_name)
    try:
        task_result = async_result.get(timeout=timeout_seconds)
    except CeleryTimeoutError:
        current_app.logger.error(
            "Timed out waiting for transcoder stop acknowledgement (timeout=%s)",
            timeout_seconds,
        )
        payload = _status_payload(config)
        return (
            jsonify({"error": "Timed out waiting for transcoder to stop.", "status": payload}),
            HTTPStatus.GATEWAY_TIMEOUT,
        )
    except Exception as exc:  # pragma: no cover - defensive
        current_app.logger.exception("Transcoder stop task failed: %s", exc)
        payload = _status_payload(config)
        return (
            jsonify({"error": "Unable to stop transcoder.", "status": payload}),
            HTTPStatus.BAD_GATEWAY,
        )

    payload = None
    stopped = False
    if isinstance(task_result, Mapping):
        payload = task_result.get("payload")
        stopped = bool(task_result.get("stopped"))
    if not isinstance(payload, Mapping):
        payload = _status_payload(config)

    response_payload = dict(payload)
    response_payload["stopped"] = stopped

    if not stopped:
        current_app.logger.info("Stop requested with no active transcoder run; returning idle status.")

    return jsonify(response_payload), HTTPStatus.OK


@api_bp.post("/subtitles/extract")
def extract_subtitles() -> Any:
    config = current_app.config
    overrides = request.get_json(silent=True) or {}
    try:
        _build_settings(config, overrides)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST

    subtitle_meta = overrides.get("subtitle") if isinstance(overrides.get("subtitle"), Mapping) else None
    if not subtitle_meta:
        return jsonify({"error": "subtitle metadata is required"}), HTTPStatus.BAD_REQUEST
    publish_base_url = _resolve_publish_base_url(config, overrides)
    task_payload = {
        **overrides,
        "publish_base_url": publish_base_url,
        "subtitle": subtitle_meta,
    }
    queue_name = config.get("CELERY_TRANSCODE_SUBTITLE_QUEUE", "transcode_subtitles")
    async_result = extract_subtitles_task.apply_async(args=(task_payload,), queue=queue_name)
    payload = _status_payload(config)
    return jsonify({"task_id": async_result.id, "status": payload}), HTTPStatus.ACCEPTED


@api_bp.get("/tasks/<string:task_id>")
def task_status(task_id: str) -> Any:
    celery_app = current_app.extensions.get("celery")
    if celery_app is None:
        return jsonify({"error": "celery not configured"}), HTTPStatus.SERVICE_UNAVAILABLE

    async_result = celery_app.AsyncResult(task_id)
    response: dict[str, Any] = {
        "task_id": task_id,
        "state": async_result.state,
        "ready": async_result.ready(),
        "successful": async_result.successful() if async_result.ready() else False,
    }
    if async_result.failed():
        response["error"] = str(async_result.result)
    elif async_result.ready():
        response["result"] = async_result.result
    return jsonify(response)


__all__ = ["api_bp"]
