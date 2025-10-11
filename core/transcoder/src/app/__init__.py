"""Transcoder application factory."""
from __future__ import annotations

from flask import Flask

from .bootstrap import (
    configure_debug_routes,
    ensure_broker_connection,
    ensure_single_worker,
    init_logging,
    load_configuration,
)
from .extensions import (
    configure_cors,
    init_celery_app,
    init_status_broadcaster,
    init_transcoder_controller,
    register_blueprints,
    register_teardown,
)
from ..services import init_transcode_services


def create_app() -> Flask:
    """Create and configure the transcoder Flask application."""

    init_logging()
    app = Flask(__name__)
    load_configuration(app)

    ensure_broker_connection(app)
    ensure_single_worker()

    status_broadcaster = init_status_broadcaster(app)
    init_transcoder_controller(app, status_broadcaster=status_broadcaster)
    init_celery_app(app)
    init_transcode_services(app)

    register_blueprints(app)
    configure_debug_routes(app)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")
    configure_cors(app, cors_origin)
    register_teardown(app, status_broadcaster)

    return app


__all__ = ["create_app"]
