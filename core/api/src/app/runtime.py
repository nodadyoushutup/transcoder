"""Service wiring for the API Flask application."""
from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Optional

from flask import Flask

from ..routes.auth import register_auth
from .providers import db, socketio
from ..services import (
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
    ViewerService,
    ensure_chat_schema,
)


@dataclass
class AppServices:
    """Container for instantiated application services."""

    group_service: GroupService
    settings_service: SettingsService
    redis_service: RedisService
    chat_service: ChatService
    plex_service: PlexService
    viewer_service: ViewerService
    transcoder_client: TranscoderClient
    transcoder_status_service: TranscoderStatusService
    playback_state: PlaybackState
    playback_coordinator: PlaybackCoordinator
    queue_service: QueueService
    status_subscriber: Optional[TranscoderStatusSubscriber] = None


def _coerce_non_negative(value: Any, default: int = 0) -> int:
    try:
        candidate = int(value)
    except (TypeError, ValueError):
        return default
    return candidate if candidate >= 0 else default


def init_services(app: Flask) -> AppServices:
    """Instantiate application services and attach them to the Flask app."""

    group_service = GroupService()
    app.extensions["group_service"] = group_service

    settings_service = SettingsService()
    app.extensions["settings_service"] = settings_service

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

    playback_coordinator = PlaybackCoordinator(
        plex_service=plex_service,
        transcoder_client=client,
        playback_state=playback_state,
        config=app.config,
        settings_service=settings_service,
    )
    app.extensions["playback_coordinator"] = playback_coordinator

    queue_service = QueueService(
        plex_service=plex_service,
        playback_state=playback_state,
        playback_coordinator=playback_coordinator,
        redis_service=redis_service,
    )
    app.extensions["queue_service"] = queue_service

    return AppServices(
        group_service=group_service,
        settings_service=settings_service,
        redis_service=redis_service,
        chat_service=chat_service,
        plex_service=plex_service,
        viewer_service=viewer_service,
        transcoder_client=client,
        transcoder_status_service=status_service,
        playback_state=playback_state,
        playback_coordinator=playback_coordinator,
        queue_service=queue_service,
    )


def bootstrap_database(app: Flask, services: AppServices) -> None:
    """Run database migrations and seed default application state."""

    redis_service = services.redis_service

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
            register_auth(
                app,
                group_service=services.group_service,
                settings_service=services.settings_service,
            )
            ensure_chat_schema()


def start_status_subscriber(app: Flask, services: AppServices) -> TranscoderStatusSubscriber:
    """Start the Redis-backed transcoder status subscriber."""

    subscriber = TranscoderStatusSubscriber(
        redis_url=services.redis_service.redis_url,
        channel=app.config.get("TRANSCODER_STATUS_CHANNEL"),
        socketio=socketio,
        status_callback=services.queue_service.observe_status_update,
    )
    subscriber.start()
    services.status_subscriber = subscriber
    app.extensions["transcoder_status_subscriber"] = subscriber
    return subscriber


__all__ = ["AppServices", "bootstrap_database", "init_services", "start_status_subscriber"]
