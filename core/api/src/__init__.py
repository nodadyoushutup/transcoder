"""API application factory."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flask import Flask, Response, request, send_from_directory

from .config import build_default_config
from .controllers.auth import register_auth
from .controllers.chat import CHAT_BLUEPRINT
from .controllers.transcode import api_bp
from .extensions import db, socketio
from .logging_config import configure_logging
from .services import ChatService, TranscoderClient, ensure_chat_schema


def create_app() -> Flask:
    """Create and configure the API Flask application."""

    configure_logging("api")
    app = Flask(__name__)

    app.config.from_mapping(build_default_config())

    db.init_app(app)

    register_auth(app)

    chat_service = ChatService()
    app.extensions["chat_service"] = chat_service

    client = TranscoderClient(app.config["TRANSCODER_SERVICE_URL"])
    app.extensions["transcoder_client"] = client

    app.register_blueprint(api_bp)
    app.register_blueprint(CHAT_BLUEPRINT)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

    if cors_origin == "*":
        cors_allowed = "*"
    else:
        cors_allowed = [origin.strip() for origin in cors_origin.split(",") if origin.strip()]
    socketio.init_app(app, cors_allowed_origins=cors_allowed, cors_credentials=True)

    upload_dir = Path(app.config["TRANSCODER_CHAT_UPLOAD_DIR"]).expanduser()
    upload_dir.mkdir(parents=True, exist_ok=True)
    app.config["CHAT_UPLOAD_PATH"] = upload_dir

    with app.app_context():
        ensure_chat_schema()

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = cors_origin
        if cors_origin == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS"
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


__all__ = ["create_app"]
