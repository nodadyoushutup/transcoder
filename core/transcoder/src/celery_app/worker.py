"""Celery entrypoint that ensures the Flask app is initialised."""
from __future__ import annotations

from flask import Flask

from ..app import create_app


def _create_bound_app() -> Flask:
    """Instantiate the transcoder Flask app once per worker process."""

    return create_app()


flask_app = _create_bound_app()
celery = flask_app.extensions["celery"]


__all__ = ["celery", "flask_app"]
