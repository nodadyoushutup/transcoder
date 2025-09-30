"""Flask application that accepts HTTP PUT uploads from the transcoder."""
from __future__ import annotations

import os
from http import HTTPStatus
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file

from .logging import configure_logging, current_log_file

from .service import ManifestService
from .storage import ContentStore

BACKEND_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_STORAGE = BACKEND_ROOT / "public"


def create_app() -> Flask:
    configure_logging("webserver")
    app = Flask(__name__)
    storage_root_setting = app.config.get("WEB_CONTENT_ROOT") or os.getenv("WEB_CONTENT_ROOT")
    storage_root = Path(storage_root_setting) if storage_root_setting else DEFAULT_STORAGE
    store = ContentStore(storage_root)
    manifests = ManifestService(store)

    @app.get("/health")
    def health() -> Response:
        payload = {
            "status": "ok",
            "storage_root": str(storage_root),
            "log_file": str(current_log_file()) if current_log_file() else None,
        }
        return jsonify(payload)

    @app.put("/content/<path:key>")
    def put_content(key: str) -> Response:
        data = request.get_data() or b""
        try:
            stored_path = store.put(key, data)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
        return (
            jsonify({"stored": str(stored_path)}),
            HTTPStatus.CREATED,
        )

    @app.delete("/content/<path:key>")
    def delete_content(key: str) -> Response:
        try:
            deleted = store.delete(key)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
        if not deleted:
            return jsonify({"error": "not found"}), HTTPStatus.NOT_FOUND
        return ("", HTTPStatus.NO_CONTENT)

    @app.get("/content/<path:key>")
    def get_content(key: str) -> Response:
        try:
            path = store.resolve(key)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
        if not path.exists():
            return jsonify({"error": "not found"}), HTTPStatus.NOT_FOUND
        return send_file(path, conditional=True)

    @app.get("/manifest/<path:key>")
    def get_manifest(key: str) -> Response:
        try:
            payload = manifests.render(key)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST
        except FileNotFoundError:
            return jsonify({"error": "not found"}), HTTPStatus.NOT_FOUND
        return Response(payload, mimetype="application/dash+xml")

    return app
