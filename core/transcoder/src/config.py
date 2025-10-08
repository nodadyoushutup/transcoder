"""Configuration helpers for the transcoder microservice."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

try:
    from dotenv import find_dotenv, load_dotenv
except ModuleNotFoundError:  # pragma: no cover - optional dependency
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

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORE_ROOT = PROJECT_ROOT / "core"
DEFAULT_INPUT = os.getenv("TRANSCODER_INPUT", "/media/tmp/pulpfiction.mkv")

LOGGER = logging.getLogger(__name__)


def _internal_settings() -> Optional[Dict[str, Any]]:
    base_url = (
        os.getenv("TRANSCODER_API_INTERNAL_URL")
        or os.getenv("TRANSCODER_API_URL")
        or os.getenv("PUBLEX_API_URL")
    )
    token = os.getenv("TRANSCODER_INTERNAL_TOKEN")
    if not base_url or not token:
        return None

    base = base_url.strip()
    if not base:
        return None

    url = f"{base.rstrip('/')}/internal/settings"
    headers = {
        "Authorization": f"Bearer {token.strip()}",
        "Accept": "application/json",
    }
    timeout_env = os.getenv("TRANSCODER_INTERNAL_TIMEOUT", "5")
    try:
        timeout = float(timeout_env)
    except ValueError:
        timeout = 5.0

    request = urllib_request.Request(url, headers=headers)
    try:
        with urllib_request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except (urllib_error.URLError, urllib_error.HTTPError) as exc:
        LOGGER.warning("Failed to fetch transcoder settings from %s: %s", url, exc)
        return None
    except Exception as exc:  # pragma: no cover - defensive
        LOGGER.warning("Unexpected error fetching transcoder settings from %s: %s", url, exc)
        return None

    try:
        data = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        LOGGER.warning("Invalid transcoder settings payload from %s: %s", url, exc)
        return None

    if not isinstance(data, dict):
        return None
    return data


def _remote_transcoder_settings() -> Optional[Dict[str, Any]]:
    payload = _internal_settings()
    if not payload:
        return None
    section = payload.get("transcoder")
    if not isinstance(section, dict):
        return None
    effective = section.get("effective")
    if isinstance(effective, dict):
        return effective
    merged: dict[str, Any] = {}
    defaults = section.get("defaults")
    if isinstance(defaults, dict):
        merged.update(defaults)
    settings = section.get("settings")
    if isinstance(settings, dict):
        merged.update(settings)
    return merged or None


REMOTE_TRANSCODER_SETTINGS = _remote_transcoder_settings()


def _remote_str(key: str) -> Optional[str]:
    if not REMOTE_TRANSCODER_SETTINGS:
        return None
    value = REMOTE_TRANSCODER_SETTINGS.get(key)
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    return None


def _remote_bool(key: str) -> Optional[bool]:
    if not REMOTE_TRANSCODER_SETTINGS:
        return None
    value = REMOTE_TRANSCODER_SETTINGS.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return None

_shared_output = os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
_explicit_output = os.getenv("TRANSCODER_OUTPUT")
_remote_output = _remote_str("TRANSCODER_LOCAL_OUTPUT_DIR")
if _remote_output:
    DEFAULT_OUTPUT = _remote_output
elif _explicit_output:
    DEFAULT_OUTPUT = _explicit_output
elif _shared_output:
    DEFAULT_OUTPUT = _shared_output
else:
    DEFAULT_OUTPUT = str(Path.home() / "transcode_data")

DEFAULT_BASENAME = (
    _remote_str("TRANSCODER_OUTPUT_BASENAME")
    or os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
)

DEFAULT_LOCAL_MEDIA_BASE_URL = (
    _remote_str("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    or os.getenv("TRANSCODER_LOCAL_MEDIA_BASE_URL")
    or "http://localhost:5005/media/"
)

DEFAULT_PUBLISH_BASE_URL = (
    _remote_str("TRANSCODER_PUBLISH_BASE_URL")
    or os.getenv("TRANSCODER_PUBLISH_BASE_URL")
    or DEFAULT_LOCAL_MEDIA_BASE_URL
)

DEFAULT_CORS_ORIGIN = (
    _remote_str("TRANSCODER_CORS_ORIGIN")
    or os.getenv("TRANSCODER_CORS_ORIGIN")
    or "*"
)

_force_new_conn_env = os.getenv("TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION")
remote_force_new = _remote_bool("TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION")
if remote_force_new is not None:
    DEFAULT_PUBLISH_FORCE_NEW_CONNECTION = remote_force_new
elif _force_new_conn_env is None:
    DEFAULT_PUBLISH_FORCE_NEW_CONNECTION = True
else:
    DEFAULT_PUBLISH_FORCE_NEW_CONNECTION = _force_new_conn_env.strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

_auto_keyframing_env = os.getenv("TRANSCODER_AUTO_KEYFRAMING")
remote_auto_keyframing = _remote_bool("TRANSCODER_AUTO_KEYFRAMING")
if remote_auto_keyframing is not None:
    DEFAULT_AUTO_KEYFRAMING = remote_auto_keyframing
elif _auto_keyframing_env is not None:
    DEFAULT_AUTO_KEYFRAMING = _auto_keyframing_env.strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
else:
    DEFAULT_AUTO_KEYFRAMING = True

DEFAULT_REDIS_URL = (
    os.getenv("TRANSCODER_REDIS_URL")
    or os.getenv("REDIS_URL")
    or os.getenv("CELERY_BROKER_URL")
    or "redis://127.0.0.1:6379/0"
)

DEFAULT_STATUS_REDIS_URL = (
    os.getenv("TRANSCODER_STATUS_REDIS_URL")
    or DEFAULT_REDIS_URL
)

DEFAULT_STATUS_PREFIX = os.getenv("TRANSCODER_STATUS_PREFIX", "publex")
DEFAULT_STATUS_NAMESPACE = os.getenv("TRANSCODER_STATUS_NAMESPACE", "transcoder")
DEFAULT_STATUS_KEY = os.getenv("TRANSCODER_STATUS_KEY", "status")
DEFAULT_STATUS_CHANNEL = os.getenv("TRANSCODER_STATUS_CHANNEL", "publex:transcoder:status")

def _coerce_int(value: Optional[str], fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


DEFAULT_STATUS_TTL_SECONDS = _coerce_int(
    os.getenv("TRANSCODER_STATUS_TTL_SECONDS"),
    30,
)

DEFAULT_STATUS_HEARTBEAT_SECONDS = _coerce_int(
    os.getenv("TRANSCODER_STATUS_HEARTBEAT_SECONDS"),
    5,
)

_debug_endpoint_env = os.getenv("TRANSCODER_DEBUG_ENDPOINT_ENABLED")
remote_debug_endpoint = _remote_bool("TRANSCODER_DEBUG_ENDPOINT_ENABLED")
if remote_debug_endpoint is not None:
    DEFAULT_DEBUG_ENDPOINT_ENABLED = remote_debug_endpoint
elif _debug_endpoint_env is not None:
    DEFAULT_DEBUG_ENDPOINT_ENABLED = _debug_endpoint_env.strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
else:
    DEFAULT_DEBUG_ENDPOINT_ENABLED = True

DEFAULT_CELERY_RESULT_BACKEND = (
    os.getenv("CELERY_RESULT_BACKEND")
    or DEFAULT_REDIS_URL
)

DEFAULT_CELERY_AV_QUEUE = os.getenv("CELERY_TRANSCODE_AV_QUEUE", "transcode_av")
DEFAULT_CELERY_SUB_QUEUE = os.getenv("CELERY_TRANSCODE_SUBTITLE_QUEUE", "transcode_subtitles")


def build_default_config() -> Dict[str, Any]:
    """Return the base configuration mapping for the microservice."""

    cfg: Dict[str, Any] = {
        "TRANSCODER_INPUT": DEFAULT_INPUT,
        "TRANSCODER_OUTPUT": DEFAULT_OUTPUT,
        "TRANSCODER_OUTPUT_BASENAME": DEFAULT_BASENAME,
        "TRANSCODER_PUBLISH_BASE_URL": DEFAULT_PUBLISH_BASE_URL,
        "TRANSCODER_LOCAL_MEDIA_BASE_URL": DEFAULT_LOCAL_MEDIA_BASE_URL,
        "TRANSCODER_CORS_ORIGIN": DEFAULT_CORS_ORIGIN,
        "TRANSCODER_AUTO_KEYFRAMING": DEFAULT_AUTO_KEYFRAMING,
        "TRANSCODER_DEBUG_ENDPOINT_ENABLED": DEFAULT_DEBUG_ENDPOINT_ENABLED,
        "TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION": DEFAULT_PUBLISH_FORCE_NEW_CONNECTION,
        "CELERY_BROKER_URL": DEFAULT_REDIS_URL,
        "CELERY_RESULT_BACKEND": DEFAULT_CELERY_RESULT_BACKEND,
        "CELERY_TASK_DEFAULT_QUEUE": DEFAULT_CELERY_SUB_QUEUE,
        "CELERY_TRANSCODE_AV_QUEUE": DEFAULT_CELERY_AV_QUEUE,
        "CELERY_TRANSCODE_SUBTITLE_QUEUE": DEFAULT_CELERY_SUB_QUEUE,
        "TRANSCODER_INTERNAL_TOKEN": os.getenv("TRANSCODER_INTERNAL_TOKEN"),
        "TRANSCODER_STATUS_REDIS_URL": DEFAULT_STATUS_REDIS_URL,
        "TRANSCODER_STATUS_PREFIX": DEFAULT_STATUS_PREFIX,
        "TRANSCODER_STATUS_NAMESPACE": DEFAULT_STATUS_NAMESPACE,
        "TRANSCODER_STATUS_KEY": DEFAULT_STATUS_KEY,
        "TRANSCODER_STATUS_CHANNEL": DEFAULT_STATUS_CHANNEL,
        "TRANSCODER_STATUS_TTL_SECONDS": DEFAULT_STATUS_TTL_SECONDS,
        "TRANSCODER_STATUS_HEARTBEAT_SECONDS": DEFAULT_STATUS_HEARTBEAT_SECONDS,
    }
    return cfg


__all__ = ["build_default_config"]
