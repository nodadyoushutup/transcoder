"""Celery worker entrypoint for the API service."""
from __future__ import annotations

from flask import Flask

from ..app import create_app
from .app import celery, init_celery


def _create_bound_app() -> Flask:
    """Instantiate the API Flask app once per worker process."""

    app = create_app()
    init_celery(app)
    return app


flask_app = _create_bound_app()

# Celery looks for a top-level ``celery`` attribute on the module referenced via ``-A``.
celery_app = celery

__all__ = ["celery", "celery_app", "flask_app"]
