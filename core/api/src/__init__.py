"""API application factory."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flask import Flask, Response, request, send_from_directory

from .config import build_default_config
from .controllers.auth import register_auth
from .controllers.chat import CHAT_BLUEPRINT
from .controllers.settings import SETTINGS_BLUEPRINT
from .controllers.library import LIBRARY_BLUEPRINT
from .controllers.transcode import api_bp
from .controllers.users import USERS_BLUEPRINT
from .controllers.viewers import VIEWERS_BLUEPRINT
from .extensions import db, socketio
from .logging_config import configure_logging
from .services import (
    ChatService,
    GroupService,
    PlexService,
    SettingsService,
    TranscoderClient,
    ensure_chat_schema,
)
from .services.viewer_service import ViewerService


def create_app() -> Flask:
    """Create and configure the API Flask application."""

    configure_logging("api")
    app = Flask(__name__)

    app.config.from_mapping(build_default_config())

    db.init_app(app)

    group_service = GroupService()
    settings_service = SettingsService()
    app.extensions["group_service"] = group_service
    app.extensions["settings_service"] = settings_service

    register_auth(app, group_service=group_service, settings_service=settings_service)

    chat_service = ChatService()
    app.extensions["chat_service"] = chat_service

    plex_service = PlexService(
        settings_service=settings_service,
        client_identifier=app.config.get("PLEX_CLIENT_IDENTIFIER"),
        product=app.config.get("PLEX_PRODUCT"),
        device_name=app.config.get("PLEX_DEVICE_NAME"),
        platform=app.config.get("PLEX_PLATFORM"),
        version=app.config.get("PLEX_VERSION"),
        server_base_url=app.config.get("PLEX_SERVER_BASE_URL"),
        allow_account_lookup=app.config.get("PLEX_ENABLE_ACCOUNT_LOOKUP", False),
        request_timeout=app.config.get("PLEX_TIMEOUT_SECONDS"),
        image_cache_dir=app.config.get("PLEX_IMAGE_CACHE_DIR"),
    )
    app.extensions["plex_service"] = plex_service

    viewer_service = ViewerService()
    app.extensions["viewer_service"] = viewer_service

    client = TranscoderClient(app.config["TRANSCODER_SERVICE_URL"])
    app.extensions["transcoder_client"] = client

    app.register_blueprint(api_bp)
    app.register_blueprint(CHAT_BLUEPRINT)
    app.register_blueprint(SETTINGS_BLUEPRINT)
    app.register_blueprint(USERS_BLUEPRINT)
    app.register_blueprint(VIEWERS_BLUEPRINT)
    app.register_blueprint(LIBRARY_BLUEPRINT)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

    if cors_origin == "*":
        cors_allowed = "*"
    else:
        cors_allowed = [origin.strip() for origin in cors_origin.split(",") if origin.strip()]
    socketio.init_app(app, cors_allowed_origins=cors_allowed, cors_credentials=True)

    upload_dir = Path(app.config["TRANSCODER_CHAT_UPLOAD_DIR"]).expanduser()
    upload_dir.mkdir(parents=True, exist_ok=True)
    app.config["CHAT_UPLOAD_PATH"] = upload_dir

    avatar_dir = Path(app.config["TRANSCODER_AVATAR_UPLOAD_DIR"]).expanduser()
    avatar_dir.mkdir(parents=True, exist_ok=True)
    app.config["AVATAR_UPLOAD_PATH"] = avatar_dir

    with app.app_context():
        ensure_chat_schema()

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = cors_origin
        if cors_origin == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS"
        if allowed_origin != "*":
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        if origin:
            response.headers.add("Vary", "Origin")
        return response

    @app.get("/media/<path:filename>")
    def serve_media(filename: str) -> Any:
        output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
        return send_from_directory(str(output_root), filename)

    return app


__all__ = ["create_app"]
