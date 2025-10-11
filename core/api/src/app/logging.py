"""Logging helpers for the API Flask service."""
from __future__ import annotations

from pathlib import Path

from .logging_config import configure_logging as _configure_logging
from .logging_config import current_log_file


def configure_logging(service_name: str = "api") -> Path:
    """Configure structured logging for the API service."""

    return _configure_logging(service_name)


__all__ = ["configure_logging", "current_log_file"]
