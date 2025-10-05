"""Transcoder application factory."""
from __future__ import annotations

import os
from typing import Optional

from flask import Flask, Response, request, send_from_directory

from .config import build_default_config
from .controllers.transcode import api_bp
from .logging_config import configure_logging
from .services.controller import TranscoderController
from .services.status_broadcaster import TranscoderStatusBroadcaster
from .celery_app import init_celery


def _ensure_redis_connection(url: Optional[str], *, label: str) -> None:
    candidate = (url or "").strip()
    if not candidate:
        raise RuntimeError(f"{label} URL not configured.")
    try:  # pragma: no cover - optional dependency
        import redis  # type: ignore
    except Exception as exc:  # pragma: no cover - redis missing
        raise RuntimeError(
            f"redis package is required for {label.lower()} connections: {exc}"
        ) from exc

    client = None
    try:
        client = redis.from_url(
            candidate,
            socket_timeout=3,
            health_check_interval=30,
        )
        client.ping()
    except Exception as exc:  # pragma: no cover - network dependent
        raise RuntimeError(f"Unable to connect to {label} at {candidate}: {exc}") from exc
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:  # pragma: no cover - defensive
                pass


def _coerce_bool(value):
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


def create_app() -> Flask:
    """Create and configure the transcoder Flask application."""

    configure_logging("transcoder")
    app = Flask(__name__)
    app.config.from_mapping(build_default_config())

    _ensure_redis_connection(app.config.get("CELERY_BROKER_URL"), label="Celery broker")

    worker_count = 1
    raw_worker_count = (
        os.getenv("TRANSCODER_WORKER_PROCESSES")
        or os.getenv("GUNICORN_WORKERS")
        or os.getenv("WEB_CONCURRENCY")
    )
    if raw_worker_count:
        try:
            worker_count = max(1, int(raw_worker_count))
        except ValueError:
            worker_count = 1
    if worker_count != 1:
        raise RuntimeError(
            "Transcoder microservice requires a single worker process. "
            "Set GUNICORN_WORKERS=1 (or WEB_CONCURRENCY=1) before launching. "
            f"Detected {worker_count}."
        )

    status_broadcaster = TranscoderStatusBroadcaster(
        redis_url=app.config.get("TRANSCODER_STATUS_REDIS_URL"),
        prefix=app.config.get("TRANSCODER_STATUS_PREFIX", "publex"),
        namespace=app.config.get("TRANSCODER_STATUS_NAMESPACE", "transcoder"),
        key=app.config.get("TRANSCODER_STATUS_KEY", "status"),
        channel=app.config.get("TRANSCODER_STATUS_CHANNEL"),
        ttl_seconds=int(app.config.get("TRANSCODER_STATUS_TTL_SECONDS", 30) or 0),
    )
    app.extensions["transcoder_status_broadcaster"] = status_broadcaster
    if not status_broadcaster.available:
        raise RuntimeError(status_broadcaster.last_error or "Unable to establish Redis connection for status broadcasting.")

    controller = TranscoderController(
        local_media_base=app.config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL"),
        publish_force_new_connection=_coerce_bool(
            app.config.get("TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION", False)
        ),
        status_broadcaster=status_broadcaster,
        heartbeat_interval=int(app.config.get("TRANSCODER_STATUS_HEARTBEAT_SECONDS", 5) or 5),
    )
    app.extensions["transcoder_controller"] = controller
    controller.broadcast_status()

    celery_app = init_celery(app)
    # Ensure tasks module is imported so Celery registers task definitions
    from . import tasks  # noqa: F401

    app.register_blueprint(api_bp)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

    @app.teardown_appcontext
    def _shutdown_status_broadcaster(_exc: Optional[BaseException]) -> None:
        status_broadcaster.close()

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
