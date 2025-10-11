"""Extension wiring for the transcoder Flask application."""
from __future__ import annotations

from flask import Flask, Response, request

from ..celery_app import init_celery
from ..engine import TranscoderController, TranscoderStatusBroadcaster
from ..routes import api_bp


def init_status_broadcaster(app: Flask) -> TranscoderStatusBroadcaster:
    status_broadcaster = TranscoderStatusBroadcaster(
        redis_url=app.config.get("TRANSCODER_STATUS_REDIS_URL"),
        prefix=app.config.get("TRANSCODER_STATUS_PREFIX", "transcoder"),
        namespace=app.config.get("TRANSCODER_STATUS_NAMESPACE", "transcoder"),
        key=app.config.get("TRANSCODER_STATUS_KEY", "status"),
        channel=app.config.get("TRANSCODER_STATUS_CHANNEL"),
        ttl_seconds=int(app.config.get("TRANSCODER_STATUS_TTL_SECONDS", 30) or 0),
    )
    app.extensions["transcoder_status_broadcaster"] = status_broadcaster
    if not status_broadcaster.available:
        raise RuntimeError(status_broadcaster.last_error or "Unable to establish Redis connection for status broadcasting.")
    return status_broadcaster


def init_transcoder_controller(
    app: Flask,
    *,
    status_broadcaster: TranscoderStatusBroadcaster,
) -> TranscoderController:
    controller = TranscoderController(
        local_media_base=app.config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL"),
        status_broadcaster=status_broadcaster,
        heartbeat_interval=int(app.config.get("TRANSCODER_STATUS_HEARTBEAT_SECONDS", 5) or 5),
    )
    app.extensions["transcoder_controller"] = controller
    controller.broadcast_status()
    return controller


def init_celery_app(app: Flask) -> None:
    celery_app = init_celery(app)
    # Ensure Celery tasks are registered
    from ..celery_app import tasks as _tasks  # noqa: F401

    app.extensions["celery_app"] = celery_app


def register_blueprints(app: Flask) -> None:
    app.register_blueprint(api_bp)


def register_teardown(app: Flask, status_broadcaster: TranscoderStatusBroadcaster) -> None:
    @app.teardown_appcontext
    def _shutdown_status_broadcaster(_exc: BaseException | None) -> None:
        status_broadcaster.close()


def configure_cors(app: Flask, cors_origin: str | None) -> None:
    allowed_default = cors_origin or "*"

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = allowed_default
        if allowed_default == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers.setdefault("Access-Control-Allow-Headers", "Content-Type")
        response.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        if allowed_origin != "*":
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        if origin:
            response.headers.add("Vary", "Origin")
        return response


__all__ = [
    "configure_cors",
    "init_celery_app",
    "init_status_broadcaster",
    "init_transcoder_controller",
    "register_blueprints",
    "register_teardown",
]
