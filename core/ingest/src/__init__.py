"""Ingest service application factory."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from flask import Flask, Response, abort, jsonify, request, send_from_directory

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

    def resolve_target(name: str) -> Path:
        candidate = (output_root / name).expanduser().resolve()
        try:
            candidate.relative_to(output_root)
        except ValueError:
            abort(400, description="Invalid media path")
        return candidate

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
            return send_from_directory(str(output_root), filename, conditional=True)

        if request.method == "PUT":
            if not app.config.get("INGEST_ENABLE_PUT", True):
                abort(405)
            was_existing = target.exists()
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as handle:
                shutil.copyfileobj(request.stream, handle, length=1024 * 1024)
            LOGGER.info("Stored %s (%s)", target, "replace" if was_existing else "create")
            return "", 200 if was_existing else 201

        if request.method == "DELETE":
            if not app.config.get("INGEST_ENABLE_DELETE", True):
                return "", 204
            if target.exists():
                try:
                    target.unlink()
                    LOGGER.info("Deleted %s", target)
                except OSError as exc:
                    LOGGER.exception("Failed to delete %s", target)
                    abort(500, description=str(exc))
            return "", 204

        abort(405)

    return app


__all__ = ["create_app"]
