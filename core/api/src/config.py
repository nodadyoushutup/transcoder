"""Configuration helpers for the API Flask app."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from dotenv import find_dotenv, load_dotenv
except ModuleNotFoundError:  # pragma: no cover - optional dependency during bootstrapping
    def _ensure_dotenv_loaded() -> None:
        return None
else:
    def _ensure_dotenv_loaded() -> None:
        dotenv_path = find_dotenv(usecwd=True)
        if dotenv_path:
            load_dotenv(dotenv_path, override=False)


_ensure_dotenv_loaded()
try:
    del _ensure_dotenv_loaded
except NameError:
    pass


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, minimum: Optional[int] = None, maximum: Optional[int] = None) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    if minimum is not None and value < minimum:
        return default
    if maximum is not None and value > maximum:
        return default
    return value

API_ROOT = Path(__file__).resolve().parents[1]
SHARED_OUTPUT = os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
DEFAULT_OUTPUT = (
    os.getenv("TRANSCODER_OUTPUT")
    or SHARED_OUTPUT
    or str(Path.home() / "transcode_data")
)
DEFAULT_BASENAME = os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
DEFAULT_LOCAL_MEDIA_BASE_URL = os.getenv(
    "TRANSCODER_LOCAL_MEDIA_BASE_URL",
    "http://localhost:5005/media/",
)
DEFAULT_PUBLISH_BASE_URL = (
    os.getenv("TRANSCODER_PUBLISH_BASE_URL")
    or DEFAULT_LOCAL_MEDIA_BASE_URL
)
DEFAULT_TRANSCODER_SERVICE_URL = os.getenv(
    "TRANSCODER_SERVICE_URL",
    "http://localhost:5003",
)
DEFAULT_INGEST_CONTROL_URL = (
    os.getenv("INGEST_CONTROL_URL")
    or os.getenv("TRANSCODER_INGEST_INTERNAL_URL")
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
DEFAULT_PLEX_IMAGE_CACHE_DIR = os.getenv(
    "TRANSCODER_PLEX_IMAGE_CACHE_DIR",
    str(API_ROOT / "data" / "plex_image_cache"),
)
DEFAULT_PLEX_CLIENT_IDENTIFIER = os.getenv(
    "PLEX_CLIENT_IDENTIFIER", "publex-transcoder")
DEFAULT_PLEX_PRODUCT = os.getenv("PLEX_PRODUCT", "Publex Transcoder")
DEFAULT_PLEX_DEVICE_NAME = os.getenv(
    "PLEX_DEVICE_NAME", "Publex Admin Console")
DEFAULT_PLEX_PLATFORM = os.getenv("PLEX_PLATFORM", "Publex")
DEFAULT_PLEX_VERSION = os.getenv("PLEX_VERSION", "1.0")
DEFAULT_PLEX_SERVER_BASE_URL = os.getenv(
    "PLEX_SERVER_BASE_URL", "http://192.168.1.100:32400")
DEFAULT_PLEX_ENABLE_ACCOUNT_LOOKUP = _env_bool(
    "PLEX_ENABLE_ACCOUNT_LOOKUP",
    False,
)
DEFAULT_PLEX_TIMEOUT_SECONDS = _env_int(
    "PLEX_TIMEOUT_SECONDS",
    180,
    minimum=1,
)
DEFAULT_INTERNAL_TOKEN = os.getenv("TRANSCODER_INTERNAL_TOKEN")
DEFAULT_STATUS_NAMESPACE = os.getenv("TRANSCODER_STATUS_NAMESPACE", "transcoder")
DEFAULT_STATUS_KEY = os.getenv("TRANSCODER_STATUS_KEY", "status")
DEFAULT_STATUS_STALE_SECONDS = _env_int(
    "TRANSCODER_STATUS_STALE_SECONDS",
    15,
    minimum=1,
)
DEFAULT_STATUS_CHANNEL = os.getenv(
    "TRANSCODER_STATUS_CHANNEL",
    "publex:transcoder:status",
)

DEFAULT_REDIS_URL = (
    os.getenv("TRANSCODER_REDIS_URL")
    or os.getenv("REDIS_URL")
    or os.getenv("CELERY_BROKER_URL")
    or "redis://127.0.0.1:6379/0"
)
DEFAULT_REDIS_MAX_ENTRIES = _env_int(
    "TRANSCODER_REDIS_MAX_ENTRIES",
    0,
    minimum=0,
    maximum=50000,
)
DEFAULT_REDIS_TTL_SECONDS = _env_int(
    "TRANSCODER_REDIS_TTL_SECONDS",
    0,
    minimum=0,
    maximum=86400 * 7,
)
DEFAULT_REDIS_PREFIX = os.getenv("TRANSCODER_REDIS_PREFIX", "publex")


def build_default_config() -> Dict[str, Any]:
    """Return the base configuration mapping for the API service."""

    secret_key = os.getenv(
        "TRANSCODER_SECRET_KEY") or os.getenv("FLASK_SECRET_KEY")
    database_uri = os.getenv(
        "TRANSCODER_DATABASE_URI") or os.getenv("TRANSCODER_USER_DB")
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
        "INGEST_CONTROL_URL": DEFAULT_INGEST_CONTROL_URL,
        "TRANSCODER_CORS_ORIGIN": DEFAULT_CORS_ORIGIN,
        "TRANSCODER_CHAT_UPLOAD_DIR": DEFAULT_CHAT_UPLOAD_DIR,
        "TRANSCODER_AVATAR_UPLOAD_DIR": DEFAULT_AVATAR_UPLOAD_DIR,
        "PLEX_IMAGE_CACHE_DIR": DEFAULT_PLEX_IMAGE_CACHE_DIR,
        "PLEX_CLIENT_IDENTIFIER": DEFAULT_PLEX_CLIENT_IDENTIFIER,
        "PLEX_PRODUCT": DEFAULT_PLEX_PRODUCT,
        "PLEX_DEVICE_NAME": DEFAULT_PLEX_DEVICE_NAME,
        "PLEX_PLATFORM": DEFAULT_PLEX_PLATFORM,
        "PLEX_VERSION": DEFAULT_PLEX_VERSION,
        "PLEX_SERVER_BASE_URL": DEFAULT_PLEX_SERVER_BASE_URL,
        "PLEX_ENABLE_ACCOUNT_LOOKUP": DEFAULT_PLEX_ENABLE_ACCOUNT_LOOKUP,
        "PLEX_TIMEOUT_SECONDS": DEFAULT_PLEX_TIMEOUT_SECONDS,
        "TRANSCODER_INTERNAL_TOKEN": DEFAULT_INTERNAL_TOKEN,
        "TRANSCODER_STATUS_NAMESPACE": DEFAULT_STATUS_NAMESPACE,
        "TRANSCODER_STATUS_KEY": DEFAULT_STATUS_KEY,
        "TRANSCODER_STATUS_STALE_SECONDS": DEFAULT_STATUS_STALE_SECONDS,
        "TRANSCODER_STATUS_CHANNEL": DEFAULT_STATUS_CHANNEL,
        "REDIS_URL": DEFAULT_REDIS_URL,
        "REDIS_MAX_ENTRIES": DEFAULT_REDIS_MAX_ENTRIES,
        "REDIS_TTL_SECONDS": DEFAULT_REDIS_TTL_SECONDS,
        "REDIS_PREFIX": DEFAULT_REDIS_PREFIX,
    }
    return cfg


__all__ = [
    "API_ROOT",
    "DEFAULT_SQLITE_PATH",
    "DEFAULT_CHAT_UPLOAD_DIR",
    "DEFAULT_AVATAR_UPLOAD_DIR",
    "DEFAULT_PLEX_IMAGE_CACHE_DIR",
    "build_default_config",
]
