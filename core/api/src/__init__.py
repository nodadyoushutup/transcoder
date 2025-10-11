"""API application factory."""
from __future__ import annotations

from .app import create_app
from .app.logging import current_log_file

__all__ = ["create_app", "current_log_file"]
