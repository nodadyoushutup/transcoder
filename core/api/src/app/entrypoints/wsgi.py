"""Gunicorn entrypoint for the API service."""
from __future__ import annotations

from .. import create_app


app = create_app()


__all__ = ["app"]
