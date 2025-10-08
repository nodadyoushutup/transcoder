"""Transcoder application factory."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from flask import Flask, Response, abort, request, send_from_directory

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

    debug_endpoint_enabled = _coerce_bool(app.config.get("TRANSCODER_DEBUG_ENDPOINT_ENABLED"))
    if debug_endpoint_enabled:
        output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        default_manifest = f"{app.config.get('TRANSCODER_OUTPUT_BASENAME', 'audio_video')}.mpd"

        cache_max_age = int(app.config.get("TRANSCODER_DEBUG_CACHE_MAX_AGE", 0) or 0)
        raw_cache_exts = app.config.get("TRANSCODER_DEBUG_CACHE_EXTENSIONS")
        if isinstance(raw_cache_exts, str):
            cache_extensions = {
                ext.strip().lower().lstrip(".")
                for ext in raw_cache_exts.split(",")
                if ext.strip()
            }
        elif isinstance(raw_cache_exts, (list, tuple, set)):
            cache_extensions = {
                str(ext).strip().lower().lstrip(".")
                for ext in raw_cache_exts
                if str(ext).strip()
            }
        else:
            cache_extensions = {"mp4", "m4s", "m4a", "m4v", "vtt", "ts"}

        def _resolve_debug_path(fragment: str) -> Path:
            target = (output_root / fragment).expanduser().resolve()
            try:
                target.relative_to(output_root)
            except ValueError:
                abort(400, description="Invalid media path")
            return target

        def _should_cache(filename: str) -> bool:
            if not cache_extensions:
                return False
            if "." not in filename:
                return False
            extension = filename.rsplit(".", 1)[-1].lower()
            if extension == "mpd":
                return False
            return extension in cache_extensions

        def _serve_debug_media(requested_path: str) -> Response:
            candidate = requested_path or default_manifest
            target = _resolve_debug_path(candidate)
            if target.is_dir():
                abort(403, description="Directories are not browsable")
            if not target.exists() or not target.is_file():
                abort(404)
            relative = target.relative_to(output_root)
            relative_path = relative.as_posix()
            should_cache = _should_cache(relative_path)
            response = send_from_directory(
                str(output_root),
                relative_path,
                conditional=True,
                max_age=cache_max_age if should_cache and cache_max_age > 0 else None,
            )
            if should_cache:
                if cache_max_age > 0:
                    response.headers["Cache-Control"] = f"public, max-age={cache_max_age}"
                else:
                    response.headers.setdefault("Cache-Control", "no-cache")
                etag, _ = response.get_etag()
                if etag is None:
                    response.set_etag(str(target.stat().st_mtime_ns))
                if response.last_modified is None:
                    response.last_modified = datetime.fromtimestamp(
                        target.stat().st_mtime,
                        tz=timezone.utc,
                    )
            return response

        @app.route("/debug/media", defaults={"requested_path": ""}, methods=["GET", "HEAD"])
        @app.route("/debug/media/", defaults={"requested_path": ""}, methods=["GET", "HEAD"])
        @app.route("/debug/media/<path:requested_path>", methods=["GET", "HEAD"])
        def debug_media(requested_path: str) -> Response:
            return _serve_debug_media(requested_path)

        @app.route("/media", defaults={"requested_path": ""}, methods=["GET", "HEAD"])
        @app.route("/media/", defaults={"requested_path": ""}, methods=["GET", "HEAD"])
        @app.route("/media/<path:requested_path>", methods=["GET", "HEAD"])
        def media_proxy(requested_path: str) -> Response:
            return _serve_debug_media(requested_path)

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
