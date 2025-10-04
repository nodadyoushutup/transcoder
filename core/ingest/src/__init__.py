"""Ingest service application factory."""
from __future__ import annotations

import logging
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory

from .config import build_default_config
from .logging_config import configure_logging

LOGGER = logging.getLogger(__name__)


def create_app() -> Flask:
    """Create and configure the ingest Flask application."""

    configure_logging("ingest")
    app = Flask(__name__)
    app.config.from_mapping(build_default_config())

    output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

    cache_max_age = int(app.config.get("INGEST_CACHE_MAX_AGE", 0))
    raw_cache_exts: Iterable[str]
    cache_config = app.config.get("INGEST_CACHE_EXTENSIONS", ())
    if isinstance(cache_config, str):
        raw_cache_exts = [piece.strip() for piece in cache_config.split(",") if piece.strip()]
    else:
        raw_cache_exts = cache_config
    cache_extensions = {ext.lower().lstrip(".") for ext in raw_cache_exts}

    def resolve_target(name: str) -> Path:
        candidate = (output_root / name).expanduser().resolve()
        try:
            candidate.relative_to(output_root)
        except ValueError:
            abort(400, description="Invalid media path")
        return candidate

    def _should_cache(name: str) -> bool:
        if not cache_extensions:
            return False
        if "." not in name:
            return False
        return name.rsplit(".", 1)[-1].lower() in cache_extensions

    def _remote_addr() -> str:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return request.remote_addr or "unknown"

    @app.before_request
    def track_request_start() -> None:
        g.ingest_started = time.perf_counter()

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = cors_origin
        if cors_origin == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,PUT,DELETE,HEAD,OPTIONS"
        if allowed_origin != "*":
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        if origin:
            response.headers.add("Vary", "Origin")

        duration_ms: float | None = None
        if hasattr(g, "ingest_started"):
            duration_ms = (time.perf_counter() - g.ingest_started) * 1000

        content_length = response.calculate_content_length()
        if content_length is None:
            header_length = response.headers.get("Content-Length")
            if header_length is not None:
                try:
                    content_length = int(header_length)
                except ValueError:
                    content_length = None

        size_display = str(content_length) if content_length is not None else "?"
        duration_display = f"{duration_ms:.2f}" if duration_ms is not None else "?"

        LOGGER.info(
            "%s %s -> %s (%s bytes) in %s ms (client=%s)",
            request.method,
            request.path,
            response.status_code,
            size_display,
            duration_display,
            _remote_addr(),
        )
        return response

    @app.get("/health")
    def health() -> Any:
        return jsonify({
            "status": "ok",
            "output_dir": str(output_root),
            "enable_put": bool(app.config.get("INGEST_ENABLE_PUT", True)),
            "enable_delete": bool(app.config.get("INGEST_ENABLE_DELETE", True)),
        })

    @app.route("/media/<path:filename>", methods=["GET", "HEAD", "PUT", "DELETE", "OPTIONS"])
    def media(filename: str):  # type: ignore[override]
        if request.method == "OPTIONS":
            return "", 204

        target = resolve_target(filename)

        if request.method in {"GET", "HEAD"}:
            if not target.exists() or not target.is_file():
                abort(404)
            should_cache = _should_cache(filename)
            response = send_from_directory(
                str(output_root),
                filename,
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
                    # Use nanosecond precision mtime so clients can short-circuit re-downloads quickly.
                    response.set_etag(str(target.stat().st_mtime_ns))

                if response.last_modified is None:
                    response.last_modified = datetime.fromtimestamp(
                        target.stat().st_mtime, tz=timezone.utc
                    )

            return response

        if request.method == "PUT":
            if not app.config.get("INGEST_ENABLE_PUT", True):
                abort(405)
            was_existing = target.exists()
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as handle:
                shutil.copyfileobj(request.stream, handle, length=1024 * 1024)
            size_bytes = target.stat().st_size
            LOGGER.info(
                "Stored %s (%s) size=%d bytes (client=%s)",
                target,
                "replace" if was_existing else "create",
                size_bytes,
                _remote_addr(),
            )
            return "", 200 if was_existing else 201

        if request.method == "DELETE":
            if not app.config.get("INGEST_ENABLE_DELETE", True):
                return "", 204
            if target.exists():
                try:
                    target.unlink()
                    LOGGER.info("Deleted %s (client=%s)", target, _remote_addr())
                except OSError as exc:
                    LOGGER.exception("Failed to delete %s", target)
                    abort(500, description=str(exc))
            return "", 204

        abort(405)

    return app


__all__ = ["create_app"]
