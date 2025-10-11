"""Bootstrap helpers for the transcoder Flask application."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from flask import Flask, Response, abort, send_from_directory

from .config import build_default_config
from .logging import configure_logging
from .redis import ensure_connection
from ..utils import to_bool


def init_logging() -> None:
    """Configure structured logging for the transcoder service."""

    configure_logging("transcoder")


def load_configuration(app: Flask) -> None:
    """Populate the default configuration values on the Flask app."""

    app.config.from_mapping(build_default_config())


def ensure_single_worker() -> None:
    """Validate that the service is running with a single worker process."""

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


def ensure_broker_connection(app: Flask) -> None:
    """Verify that the Celery broker is reachable before serving traffic."""

    ensure_connection(app.config.get("CELERY_BROKER_URL"), label="Celery broker")


def configure_debug_routes(app: Flask) -> None:
    """Expose optional debug endpoints that serve DASH/HLS artifacts."""

    if not to_bool(app.config.get("TRANSCODER_DEBUG_ENDPOINT_ENABLED")):
        return

    output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    default_manifest = f"{app.config.get('TRANSCODER_OUTPUT_BASENAME', 'audio_video')}.mpd"

    cache_max_age = int(app.config.get("TRANSCODER_DEBUG_CACHE_MAX_AGE", 0) or 0)
    raw_cache_exts = app.config.get("TRANSCODER_DEBUG_CACHE_EXTENSIONS")
    cache_extensions = _normalise_cache_extensions(raw_cache_exts)

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


def _normalise_cache_extensions(raw: Optional[object]) -> set[str]:
    if isinstance(raw, str):
        return {
            ext.strip().lower().lstrip(".")
            for ext in raw.split(",")
            if ext.strip()
        }
    if isinstance(raw, Iterable):
        return {
            str(ext).strip().lower().lstrip(".")
            for ext in raw
            if str(ext).strip()
        }
    return {"mp4", "m4s", "m4a", "m4v", "vtt", "ts"}


__all__ = [
    "configure_debug_routes",
    "ensure_broker_connection",
    "ensure_single_worker",
    "init_logging",
    "load_configuration",
]
