"""Extension wiring for the API Flask application."""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional, Sequence

from flask import Flask, Response, request, send_from_directory

from .providers import db, socketio
from ..services.redis_service import RedisService
from ..services.transcoder_status import TranscoderStatusSubscriber


def init_database(app: Flask) -> None:
    """Initialise SQLAlchemy bindings."""

    db.init_app(app)


def resolve_cors_origins(raw_origin: Optional[str]) -> Sequence[str] | str:
    """Return a Socket.IO compatible CORS configuration."""

    if not raw_origin or raw_origin.strip() == "*":
        return "*"
    candidates: Iterable[str] = (fragment.strip() for fragment in raw_origin.split(","))
    allowed = [origin for origin in candidates if origin]
    return allowed or "*"


def init_socketio(app: Flask, redis_service: RedisService, cors_allowed: Sequence[str] | str) -> None:
    """Configure Socket.IO with message queue support."""

    message_queue = redis_service.message_queue_url()
    socketio.init_app(
        app,
        cors_allowed_origins=cors_allowed,
        cors_credentials=True,
        message_queue=message_queue,
    )


def register_blueprints(app: Flask) -> None:
    """Register HTTP blueprints for the API surface."""

    from ..routes import API_BLUEPRINTS

    for blueprint in API_BLUEPRINTS:
        app.register_blueprint(blueprint)


def register_media_routes(app: Flask) -> None:
    """Expose media assets served from the transcoder output directory."""

    @app.get("/media/<path:filename>")
    def serve_media(filename: str):
        output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
        return send_from_directory(str(output_root), filename)


def configure_cors(app: Flask, cors_origin: Optional[str]) -> None:
    """Attach CORS headers mirroring the transcoder microservice behaviour."""

    allowed_default = cors_origin or "*"

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = allowed_default
        if allowed_default == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers.setdefault("Access-Control-Allow-Headers", "Content-Type")
        response.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
        if allowed_origin != "*":
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        if origin:
            response.headers.add("Vary", "Origin")
        return response


def register_teardowns(app: Flask, status_subscriber: Optional[TranscoderStatusSubscriber]) -> None:
    """Ensure background workers are stopped when the app context tears down."""

    @app.teardown_appcontext
    def _shutdown_transcoder_status(_exc: Optional[BaseException]) -> None:
        if status_subscriber is not None:
            status_subscriber.stop()


__all__ = [
    "configure_cors",
    "init_database",
    "init_socketio",
    "register_blueprints",
    "register_media_routes",
    "register_teardowns",
    "resolve_cors_origins",
]
