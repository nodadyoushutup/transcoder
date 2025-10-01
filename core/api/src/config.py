"""Configuration helpers for the API Flask app."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

API_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = os.getenv(
    "TRANSCODER_OUTPUT",
    str(API_ROOT.parent / "out"),
)
DEFAULT_BASENAME = os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
DEFAULT_PUBLISH_BASE_URL = os.getenv("TRANSCODER_PUBLISH_BASE_URL")
DEFAULT_LOCAL_MEDIA_BASE_URL = os.getenv(
    "TRANSCODER_LOCAL_MEDIA_BASE_URL",
    "http://localhost:5001/media/",
)
DEFAULT_TRANSCODER_SERVICE_URL = os.getenv(
    "TRANSCODER_SERVICE_URL",
    "http://localhost:5003",
)
DEFAULT_CORS_ORIGIN = os.getenv("TRANSCODER_CORS_ORIGIN", "*")
DEFAULT_SQLITE_PATH = API_ROOT / "data" / "publex.db"
DEFAULT_CHAT_UPLOAD_DIR = os.getenv(
    "TRANSCODER_CHAT_UPLOAD_DIR",
    str(API_ROOT / "data" / "chat_uploads"),
)
DEFAULT_AVATAR_UPLOAD_DIR = os.getenv(
    "TRANSCODER_AVATAR_UPLOAD_DIR",
    str(API_ROOT / "data" / "avatars"),
)


def build_default_config() -> Dict[str, Any]:
    """Return the base configuration mapping for the API service."""

    secret_key = os.getenv("TRANSCODER_SECRET_KEY") or os.getenv("FLASK_SECRET_KEY")
    database_uri = os.getenv("TRANSCODER_DATABASE_URI") or os.getenv("TRANSCODER_USER_DB")
    if not database_uri:
        DEFAULT_SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
        database_uri = f"sqlite:///{DEFAULT_SQLITE_PATH}"

    cfg: Dict[str, Any] = {
        "SECRET_KEY": secret_key or "dev-change-me",
        "SESSION_COOKIE_SAMESITE": "Lax",
        "SESSION_COOKIE_HTTPONLY": True,
        "SQLALCHEMY_DATABASE_URI": database_uri,
        "SQLALCHEMY_TRACK_MODIFICATIONS": False,
        "TRANSCODER_OUTPUT": DEFAULT_OUTPUT,
        "TRANSCODER_OUTPUT_BASENAME": DEFAULT_BASENAME,
        "TRANSCODER_PUBLISH_BASE_URL": DEFAULT_PUBLISH_BASE_URL,
        "TRANSCODER_LOCAL_MEDIA_BASE_URL": DEFAULT_LOCAL_MEDIA_BASE_URL,
        "TRANSCODER_SERVICE_URL": DEFAULT_TRANSCODER_SERVICE_URL,
        "TRANSCODER_CORS_ORIGIN": DEFAULT_CORS_ORIGIN,
        "TRANSCODER_CHAT_UPLOAD_DIR": DEFAULT_CHAT_UPLOAD_DIR,
        "TRANSCODER_AVATAR_UPLOAD_DIR": DEFAULT_AVATAR_UPLOAD_DIR,
    }
    return cfg


__all__ = [
    "API_ROOT",
    "DEFAULT_SQLITE_PATH",
    "DEFAULT_CHAT_UPLOAD_DIR",
    "DEFAULT_AVATAR_UPLOAD_DIR",
    "build_default_config",
]
