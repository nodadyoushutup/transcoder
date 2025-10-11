"""Celery integration for the transcoder microservice."""
from __future__ import annotations

from .app import celery, init_celery

__all__ = ["celery", "init_celery"]
