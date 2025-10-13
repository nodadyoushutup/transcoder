from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Tuple

from flask import Flask, Response, abort, jsonify, request, send_file

from .logging_config import configure_logging

LOGGER = logging.getLogger(__name__)

def _resolve_root() -> Path:
    env_root = (
        os.getenv("INGEST_ROOT")
        or os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
        or (Path.home() / "ingest_data")
    )
    root = Path(env_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _within_root(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def create_app() -> Flask:
    configure_logging()
    app = Flask(__name__)
    root = _resolve_root()
    app.config["INGEST_ROOT"] = root
    LOGGER.info("Ingest root set to %s", root)

    @app.after_request
    def _apply_cors_headers(response: Response) -> Response:
        response.headers.setdefault("Access-Control-Allow-Origin", "*")
        response.headers.setdefault(
            "Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,PUT,DELETE"
        )
        response.headers.setdefault(
            "Access-Control-Allow-Headers",
            "Authorization,Content-Type,Depth,Destination,Overwrite,Range",
        )
        return response

    def _resolve_path(subpath: str) -> Path:
        candidate = (root / subpath).resolve()
        if not _within_root(root, candidate):
            abort(403)
        return candidate

    def _list_directory(path: Path) -> Tuple[list[str], list[str]]:
        files: list[str] = []
        directories: list[str] = []
        for entry in sorted(path.iterdir()):
            if entry.is_dir():
                directories.append(entry.name)
            else:
                files.append(entry.name)
        return directories, files

    @app.route("/media/", defaults={"requested_path": ""}, methods=["OPTIONS"])
    @app.route("/media/<path:requested_path>", methods=["OPTIONS"])
    def options_handler(requested_path: str) -> Response:
        response = Response(status=204)
        response.headers["Allow"] = "GET,HEAD,OPTIONS,PUT,DELETE,MKCOL"
        return response

    @app.route(
        "/media/",
        defaults={"requested_path": ""},
        methods=["GET", "HEAD", "PUT", "DELETE", "MKCOL"],
    )
    @app.route(
        "/media/<path:requested_path>",
        methods=["GET", "HEAD", "PUT", "DELETE", "MKCOL"],
    )
    def media_handler(requested_path: str) -> Response:
        full_path = _resolve_path(requested_path)
        method = request.method

        if method == "MKCOL":
            if full_path.exists():
                if full_path.is_dir():
                    return Response(status=405)
                return Response(status=409)
            try:
                full_path.mkdir(parents=True, exist_ok=False)
            except FileNotFoundError:
                return Response(status=409)
            return Response(status=201)

        if method == "PUT":
            if full_path.exists() and full_path.is_dir():
                return Response(status=409)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            with full_path.open("wb") as fh:
                shutil.copyfileobj(request.stream, fh)
            return Response(status=201)

        if method == "DELETE":
            if not full_path.exists():
                return Response(status=404)
            if full_path.is_dir():
                shutil.rmtree(full_path)
            else:
                full_path.unlink()
            return Response(status=204)

        if method == "HEAD":
            if not full_path.exists() or not full_path.is_file():
                return Response(status=404)
            return send_file(full_path, conditional=True)

        if not full_path.exists():
            return Response(status=404)
        if full_path.is_file():
            return send_file(full_path, conditional=True)
        directories, files = _list_directory(full_path)
        return jsonify({"directories": directories, "files": files})

    return app


app = create_app()
