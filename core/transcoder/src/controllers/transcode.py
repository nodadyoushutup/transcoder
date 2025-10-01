"""HTTP routes that drive the transcoder pipeline."""
from __future__ import annotations

from dataclasses import asdict
from http import HTTPStatus
from pathlib import Path
from typing import Any, Mapping, Optional

from flask import Blueprint, current_app, jsonify, request

from transcoder import EncoderSettings

from ..logging_config import current_log_file
from ..services.controller import TranscoderController

api_bp = Blueprint("transcoder_api", __name__)


def _controller() -> TranscoderController:
    ctrl: TranscoderController = current_app.extensions["transcoder_controller"]
    return ctrl


def _effective_local_media_base(config: Mapping[str, Any]) -> Optional[str]:
    configured = config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    if isinstance(configured, str) and configured.strip():
        return configured.strip().rstrip('/') + '/'
    return None


def _build_settings(config: Mapping[str, Any], overrides: Mapping[str, Any]) -> EncoderSettings:
    input_path = overrides.get("input_path") or config["TRANSCODER_INPUT"]
    output_dir = overrides.get("output_dir") or config["TRANSCODER_OUTPUT"]
    output_basename = overrides.get("output_basename") or config["TRANSCODER_OUTPUT_BASENAME"]
    realtime_input = overrides.get("realtime_input")
    settings = EncoderSettings(
        input_path=str(input_path),
        output_dir=Path(output_dir),
        output_basename=str(output_basename),
        realtime_input=True if realtime_input is None else bool(realtime_input),
    )
    return settings


def _resolve_publish_base_url(config: Mapping[str, Any], overrides: Mapping[str, Any]) -> Optional[str]:
    candidate = overrides.get("publish_base_url")
    if candidate is None or candidate == "":
        candidate = config.get("TRANSCODER_PUBLISH_BASE_URL")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return None


def _status_payload(config: Mapping[str, Any]) -> dict[str, Any]:
    payload = asdict(
        _controller().status(local_base_override=_effective_local_media_base(config))
    )
    payload["log_file"] = str(current_log_file()) if current_log_file() else None
    return payload


@api_bp.get("/health")
def health() -> Any:
    config = current_app.config
    status = _status_payload(config)
    status["defaults"] = {
        "input_path": config["TRANSCODER_INPUT"],
        "output_dir": config["TRANSCODER_OUTPUT"],
        "output_basename": config["TRANSCODER_OUTPUT_BASENAME"],
        "publish_base_url": config.get("TRANSCODER_PUBLISH_BASE_URL"),
        "local_media_base_url": _effective_local_media_base(config),
    }
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
    started = _controller().start(settings, publish_base_url)
    payload = _status_payload(config)
    if not started:
        return (
            jsonify({"error": "transcoder already running", "status": payload}),
            HTTPStatus.CONFLICT,
        )
    return jsonify(payload), HTTPStatus.ACCEPTED


@api_bp.route("/transcode/stop", methods=["POST", "OPTIONS"])
def stop_transcode() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    config = current_app.config
    stopped = _controller().stop()
    payload = _status_payload(config)
    if not stopped:
        return (
            jsonify({"error": "no active transcoder run", "status": payload}),
            HTTPStatus.CONFLICT,
        )
    return jsonify(payload), HTTPStatus.OK


__all__ = ["api_bp"]
