"""API application factory."""
from __future__ import annotations

from flask import Flask

from .bootstrap import ensure_storage_paths, init_logging, load_configuration
from .extensions import (
    configure_cors,
    init_database,
    init_socketio,
    register_blueprints,
    register_media_routes,
    register_teardowns,
    resolve_cors_origins,
)
from .runtime import bootstrap_database, init_services, start_status_subscriber
from ..celery_app import init_celery


def create_app() -> Flask:
    """Create and configure the API Flask application."""

    init_logging()
    app = Flask(__name__)
    load_configuration(app)
    ensure_storage_paths(app)

    init_database(app)
    services = init_services(app)
    bootstrap_database(app, services)
    init_celery(app)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")
    cors_setting = resolve_cors_origins(cors_origin)
    init_socketio(app, services.redis_service, cors_setting)
    register_blueprints(app)
    register_media_routes(app)
    configure_cors(app, cors_origin)

    status_subscriber = start_status_subscriber(app, services)
    register_teardowns(app, status_subscriber)

    return app


__all__ = ["create_app"]
