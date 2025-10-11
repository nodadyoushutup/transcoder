"""Remote settings overrides fetched from the API service."""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

LOGGER = logging.getLogger(__name__)

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

__all__ = ["REMOTE_TRANSCODER_SETTINGS", "remote_bool", "remote_str"]


def _internal_settings() -> Optional[Dict[str, Any]]:
    base_url = os.getenv("TRANSCODER_API_INTERNAL_URL") or os.getenv("TRANSCODER_API_URL")
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


def remote_str(key: str) -> Optional[str]:
    if not REMOTE_TRANSCODER_SETTINGS:
        return None
    value = REMOTE_TRANSCODER_SETTINGS.get(key)
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    return None


def remote_bool(key: str) -> Optional[bool]:
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
