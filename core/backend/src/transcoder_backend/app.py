"""Flask application that exposes the transcoder as a backend service."""
from __future__ import annotations

import os
from dataclasses import asdict
from http import HTTPStatus
from pathlib import Path
from typing import Any, Mapping, Optional

from flask import Flask, Response, jsonify, request, send_from_directory, url_for
from flask_login import current_user

from .logging import configure_logging, current_log_file
from transcoder import EncoderSettings

from .controller import TranscoderController
from .auth import init_auth

BACKEND_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_INPUT = os.getenv("TRANSCODER_INPUT", "/media/tmp/wicked.mkv")
DEFAULT_OUTPUT = os.getenv("TRANSCODER_OUTPUT", str(BACKEND_ROOT / "out"))
DEFAULT_BASENAME = os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
DEFAULT_PUBLISH_BASE_URL = os.getenv("TRANSCODER_PUBLISH_BASE_URL")
DEFAULT_LOCAL_MEDIA_BASE_URL = os.getenv("TRANSCODER_LOCAL_MEDIA_BASE_URL", "http://localhost:5001/media/")


def create_app() -> Flask:
    """Factory used by the CLI scripts and Flask's auto-reloader."""

    configure_logging("backend")
    app = Flask(__name__)

    secret_key = os.getenv("TRANSCODER_SECRET_KEY") or os.getenv("FLASK_SECRET_KEY")
    if secret_key:
        app.config["SECRET_KEY"] = secret_key
    else:
        app.config.setdefault("SECRET_KEY", "dev-change-me")
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault(
        "USER_DATABASE_PATH",
        os.getenv("TRANSCODER_USER_DB", str(BACKEND_ROOT / "data" / "users.sqlite3")),
    )

    app.config.setdefault("TRANSCODER_INPUT", DEFAULT_INPUT)
    app.config.setdefault("TRANSCODER_OUTPUT", DEFAULT_OUTPUT)
    app.config.setdefault("TRANSCODER_OUTPUT_BASENAME", DEFAULT_BASENAME)
    app.config.setdefault("TRANSCODER_PUBLISH_BASE_URL", DEFAULT_PUBLISH_BASE_URL)
    app.config.setdefault("TRANSCODER_LOCAL_MEDIA_BASE_URL", DEFAULT_LOCAL_MEDIA_BASE_URL)

    controller = TranscoderController(
        local_media_base=app.config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    )
    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", os.getenv("TRANSCODER_CORS_ORIGIN", "*"))

    init_auth(app)

    @app.get("/health")
    def health() -> Any:
        status = asdict(controller.status(local_base_override=_effective_local_media_base(app)))
        status["log_file"] = str(current_log_file()) if current_log_file() else None
        status["defaults"] = {
            "input_path": app.config["TRANSCODER_INPUT"],
            "output_dir": app.config["TRANSCODER_OUTPUT"],
            "output_basename": app.config["TRANSCODER_OUTPUT_BASENAME"],
            "publish_base_url": app.config.get("TRANSCODER_PUBLISH_BASE_URL"),
            "local_media_base_url": _effective_local_media_base(app),
        }
        return jsonify({"status": "ok", "transcoder": status})

    @app.get("/transcode/status")
    def get_status() -> Any:
        payload = asdict(controller.status(local_base_override=_effective_local_media_base(app)))
        payload["log_file"] = str(current_log_file()) if current_log_file() else None
        return jsonify(payload)

    @app.route("/transcode/start", methods=["POST", "OPTIONS"])
    def start_transcode() -> Any:
        if request.method == "OPTIONS":
            return "", HTTPStatus.NO_CONTENT
        if not current_user.is_authenticated:
            return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED
        body = request.get_json(silent=True) or {}
        try:
            settings = _build_settings(app, body)
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST

        publish_base_url = _resolve_publish_base_url(app, body)
        started = controller.start(settings, publish_base_url)
        payload = asdict(controller.status(local_base_override=_effective_local_media_base(app)))
        payload["log_file"] = str(current_log_file()) if current_log_file() else None
        if not started:
            return (
                jsonify({"error": "transcoder already running", "status": payload}),
                HTTPStatus.CONFLICT,
            )
        return jsonify(payload), HTTPStatus.ACCEPTED

    @app.route("/transcode/stop", methods=["POST", "OPTIONS"])
    def stop_transcode() -> Any:
        if request.method == "OPTIONS":
            return "", HTTPStatus.NO_CONTENT
        if not current_user.is_authenticated:
            return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED
        stopped = controller.stop()
        payload = asdict(controller.status(local_base_override=_effective_local_media_base(app)))
        payload["log_file"] = str(current_log_file()) if current_log_file() else None
        if not stopped:
            return (
                jsonify({"error": "no active transcoder run", "status": payload}),
                HTTPStatus.CONFLICT,
            )
        return jsonify(payload), HTTPStatus.OK

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = cors_origin
        if cors_origin == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers.setdefault("Access-Control-Allow-Headers", "Content-Type")
        response.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        if allowed_origin != "*":
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        if origin:
            response.headers.add("Vary", "Origin")
        return response

    @app.get("/media/<path:filename>")
    def serve_media(filename: str) -> Any:
        output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
        return send_from_directory(str(output_root), filename)

    return app


def _build_settings(app: Flask, overrides: Mapping[str, Any]) -> EncoderSettings:
    input_path = overrides.get("input_path") or app.config["TRANSCODER_INPUT"]
    output_dir = overrides.get("output_dir") or app.config["TRANSCODER_OUTPUT"]
    output_basename = overrides.get("output_basename") or app.config["TRANSCODER_OUTPUT_BASENAME"]
    realtime_input = overrides.get("realtime_input")
    settings = EncoderSettings(
        input_path=str(input_path),
        output_dir=Path(output_dir),
        output_basename=str(output_basename),
        realtime_input=True if realtime_input is None else bool(realtime_input),
    )
    return settings


def _resolve_publish_base_url(app: Flask, overrides: Mapping[str, Any]) -> Optional[str]:
    candidate = overrides.get("publish_base_url")
    if candidate is None or candidate == "":
        candidate = app.config.get("TRANSCODER_PUBLISH_BASE_URL")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return None


def _effective_local_media_base(app: Flask) -> Optional[str]:
    configured = app.config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    if isinstance(configured, str) and configured.strip():
        return configured.strip().rstrip('/') + '/'
    try:
        media_prefix = url_for("serve_media", filename="", _external=True)
    except RuntimeError:
        return None
    return media_prefix
