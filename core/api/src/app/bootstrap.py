"""Bootstrap helpers for the API Flask application."""
from __future__ import annotations

from pathlib import Path

from flask import Flask

from .config import build_default_config
from .logging import configure_logging


def init_logging() -> None:
    """Configure structured logging for the API service."""

    configure_logging("api")


def load_configuration(app: Flask) -> None:
    """Populate the default configuration values on the Flask app."""

    app.config.from_mapping(build_default_config())


def ensure_storage_paths(app: Flask) -> None:
    """Ensure directories used by the API service exist on disk."""

    output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser()
    output_root.mkdir(parents=True, exist_ok=True)
    app.config["TRANSCODER_OUTPUT"] = str(output_root)

    chat_dir = Path(app.config["TRANSCODER_CHAT_UPLOAD_DIR"]).expanduser()
    chat_dir.mkdir(parents=True, exist_ok=True)
    app.config["CHAT_UPLOAD_PATH"] = chat_dir

    avatar_dir = Path(app.config["TRANSCODER_AVATAR_UPLOAD_DIR"]).expanduser()
    avatar_dir.mkdir(parents=True, exist_ok=True)
    app.config["AVATAR_UPLOAD_PATH"] = avatar_dir

    image_cache_dir = Path(app.config["PLEX_IMAGE_CACHE_DIR"]).expanduser()
    image_cache_dir.mkdir(parents=True, exist_ok=True)
    app.config["PLEX_IMAGE_CACHE_DIR"] = str(image_cache_dir)


__all__ = ["ensure_storage_paths", "init_logging", "load_configuration"]
