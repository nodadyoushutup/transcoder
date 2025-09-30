"""Backend application factory."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flask import Flask, Response, request, send_from_directory

from .config import BACKEND_ROOT, build_default_config
from .controllers.auth import register_auth
from .controllers.transcode import api_bp
from .extensions import db
from .logging import configure_logging
from .services.transcoder_client import TranscoderClient


def create_app() -> Flask:
    """Create and configure the backend Flask application."""

    configure_logging("backend")
    app = Flask(__name__)

    app.config.from_mapping(build_default_config())

    db.init_app(app)

    register_auth(app)

    client = TranscoderClient(app.config["TRANSCODER_SERVICE_URL"])
    app.extensions["transcoder_client"] = client

    app.register_blueprint(api_bp)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

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


__all__ = ["create_app"]
