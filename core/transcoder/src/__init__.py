"""Transcoder application factory."""
from __future__ import annotations

from flask import Flask, Response, request

from .config import build_default_config
from .controllers.transcode import api_bp
from .logging_config import configure_logging
from .services.controller import TranscoderController


def create_app() -> Flask:
    """Create and configure the transcoder Flask application."""

    configure_logging("transcoder")
    app = Flask(__name__)
    app.config.from_mapping(build_default_config())

    controller = TranscoderController(
        local_media_base=app.config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    )
    app.extensions["transcoder_controller"] = controller

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

    return app


__all__ = ["create_app"]
