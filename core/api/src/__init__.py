"""API application factory."""
from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from typing import Any, Optional

from flask import Flask, Response, request, send_from_directory

from .config import build_default_config
from .controllers.auth import register_auth
from .controllers.chat import CHAT_BLUEPRINT
from .controllers.internal import INTERNAL_BLUEPRINT
from .controllers.settings import SETTINGS_BLUEPRINT
from .controllers.library import LIBRARY_BLUEPRINT
from .controllers.queue import QUEUE_BLUEPRINT
from .controllers.transcode import api_bp
from .controllers.users import USERS_BLUEPRINT
from .controllers.viewers import VIEWERS_BLUEPRINT
from .extensions import db, socketio
from .logging_config import configure_logging
from .services import (
    ChatService,
    GroupService,
    PlaybackCoordinator,
    PlaybackState,
    PlexService,
    QueueService,
    RedisService,
    SettingsService,
    TranscoderClient,
    TranscoderStatusService,
    TranscoderStatusSubscriber,
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

    def _coerce_non_negative(value: Any, default: int = 0) -> int:
        try:
            candidate = int(value)
        except (TypeError, ValueError):
            return default
        return candidate if candidate >= 0 else default

    redis_service = RedisService(
        redis_url=app.config.get("REDIS_URL"),
        max_entries=_coerce_non_negative(app.config.get("REDIS_MAX_ENTRIES"), 0),
        ttl_seconds=_coerce_non_negative(app.config.get("REDIS_TTL_SECONDS"), 0),
        prefix=app.config.get("REDIS_PREFIX"),
        auto_connect=False,
    )
    app.extensions["redis_service"] = redis_service

    chat_service = ChatService()
    app.extensions["chat_service"] = chat_service

    plex_service = PlexService(
        settings_service=settings_service,
        redis_service=redis_service,
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

    client = TranscoderClient(
        app.config["TRANSCODER_SERVICE_URL"],
        internal_token=app.config.get("TRANSCODER_INTERNAL_TOKEN"),
    )
    app.extensions["transcoder_client"] = client

    status_service = TranscoderStatusService(
        client=client,
        redis_service=redis_service,
        namespace=app.config.get("TRANSCODER_STATUS_NAMESPACE", "transcoder"),
        key=app.config.get("TRANSCODER_STATUS_KEY", "status"),
        stale_after_seconds=int(app.config.get("TRANSCODER_STATUS_STALE_SECONDS", 15) or 15),
    )
    app.extensions["transcoder_status_service"] = status_service

    playback_state = PlaybackState(redis_service=redis_service)
    app.extensions["playback_state"] = playback_state

    coordinator = PlaybackCoordinator(
        plex_service=plex_service,
        transcoder_client=client,
        playback_state=playback_state,
        config=app.config,
        settings_service=settings_service,
    )
    app.extensions["playback_coordinator"] = coordinator

    queue_service = QueueService(
        plex_service=plex_service,
        playback_state=playback_state,
        playback_coordinator=coordinator,
        redis_service=redis_service,
    )
    app.extensions["queue_service"] = queue_service

    app.register_blueprint(api_bp)
    app.register_blueprint(CHAT_BLUEPRINT)
    app.register_blueprint(SETTINGS_BLUEPRINT)
    app.register_blueprint(USERS_BLUEPRINT)
    app.register_blueprint(VIEWERS_BLUEPRINT)
    app.register_blueprint(LIBRARY_BLUEPRINT)
    app.register_blueprint(QUEUE_BLUEPRINT)
    app.register_blueprint(INTERNAL_BLUEPRINT)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

    if cors_origin == "*":
        cors_allowed = "*"
    else:
        cors_allowed = [origin.strip() for origin in cors_origin.split(",") if origin.strip()]

    upload_dir = Path(app.config["TRANSCODER_CHAT_UPLOAD_DIR"]).expanduser()
    upload_dir.mkdir(parents=True, exist_ok=True)
    app.config["CHAT_UPLOAD_PATH"] = upload_dir

    avatar_dir = Path(app.config["TRANSCODER_AVATAR_UPLOAD_DIR"]).expanduser()
    avatar_dir.mkdir(parents=True, exist_ok=True)
    app.config["AVATAR_UPLOAD_PATH"] = avatar_dir

    with app.app_context():
        redis_service.reload()
        if not redis_service.available:
            snapshot = redis_service.snapshot()
            last_error = snapshot.get("last_error") if isinstance(snapshot, dict) else None
            message = last_error or "Redis connection is required during startup."
            raise RuntimeError(message)
        lock_ctx = (
            redis_service.lock("bootstrap:defaults", timeout=60, blocking_timeout=60)
            if redis_service.available
            else nullcontext()
        )
        with lock_ctx:
            db.create_all()
            register_auth(app, group_service=group_service, settings_service=settings_service)
            ensure_chat_schema()

    message_queue = redis_service.message_queue_url()
    socketio.init_app(
        app,
        cors_allowed_origins=cors_allowed,
        cors_credentials=True,
        message_queue=message_queue,
    )

    status_subscriber = TranscoderStatusSubscriber(
        redis_url=redis_service.redis_url,
        channel=app.config.get("TRANSCODER_STATUS_CHANNEL"),
        socketio=socketio,
        status_callback=queue_service.observe_status_update,
    )
    status_subscriber.start()
    app.extensions["transcoder_status_subscriber"] = status_subscriber

    @app.teardown_appcontext
    def _shutdown_transcoder_status(_exc: Optional[BaseException]) -> None:
        status_subscriber.stop()

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = cors_origin
        if cors_origin == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,PUT,DELETE,OPTIONS"
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
