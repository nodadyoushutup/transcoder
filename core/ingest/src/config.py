"""Configuration helpers for the ingest service."""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

try:
    from dotenv import find_dotenv, load_dotenv
except ModuleNotFoundError:  # pragma: no cover - optional during bootstrap
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


LOGGER = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_csv(name: str, default: Iterable[str]) -> List[str]:
    raw = os.getenv(name)
    if raw is None:
        return [item for item in default]
    values = [value.strip().lower()
              for value in raw.split(",") if value.strip()]
    return values if values else [item for item in default]


SERVICE_ROOT = Path(__file__).resolve().parents[1]
SHARED_OUTPUT = os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
DEFAULT_RETENTION_FALLBACK = 36


@lru_cache(maxsize=1)
def _internal_settings() -> Optional[Dict[str, Any]]:
    base_url = (
        os.getenv("INGEST_API_BASE_URL")
        or os.getenv("TRANSCODER_API_INTERNAL_URL")
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
        LOGGER.warning("Failed to fetch ingest settings from %s: %s", url, exc)
        return None
    except Exception as exc:  # pragma: no cover - defensive
        LOGGER.warning("Unexpected error fetching ingest settings from %s: %s", url, exc)
        return None

    try:
        data = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        LOGGER.warning("Invalid ingest settings payload from %s: %s", url, exc)
        return None

    if not isinstance(data, dict):
        return None
    return data


def _remote_ingest_setting(key: str) -> Any:
    settings_payload = _internal_settings()
    if not settings_payload:
        return None
    ingest_section = settings_payload.get("ingest")
    if not isinstance(ingest_section, dict):
        return None
    for source_name in ("settings", "defaults"):
        source = ingest_section.get(source_name)
        if isinstance(source, dict) and key in source:
            return source[key]
    return None


def _remote_output_dir() -> Optional[str]:
    output_dir = _remote_ingest_setting("OUTPUT_DIR")
    if isinstance(output_dir, str):
        trimmed = output_dir.strip()
        if trimmed:
            return trimmed
    return None


REMOTE_OUTPUT = _remote_output_dir()
DEFAULT_OUTPUT = (
    REMOTE_OUTPUT
    or os.getenv("INGEST_OUTPUT_DIR")
    or os.getenv("TRANSCODER_OUTPUT")
    or SHARED_OUTPUT
    or str(SERVICE_ROOT / "out")
)
REMOTE_RETENTION_SEGMENTS = None


def _remote_retention_segments() -> Optional[int]:
    raw_value = _remote_ingest_setting("RETENTION_SEGMENTS")
    if raw_value is None:
        return None
    try:
        candidate = int(raw_value)
    except (TypeError, ValueError):
        return None
    return candidate if candidate >= 0 else None


REMOTE_RETENTION_SEGMENTS = _remote_retention_segments()
if REMOTE_RETENTION_SEGMENTS is None:
    retention_default = DEFAULT_RETENTION_FALLBACK
else:
    retention_default = REMOTE_RETENTION_SEGMENTS


def _remote_bool(name: str) -> Optional[bool]:
    value = _remote_ingest_setting(name)
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        candidate = value.strip().lower()
        if candidate in {"1", "true", "yes", "on"}:
            return True
        if candidate in {"0", "false", "no", "off"}:
            return False
    return None


def _remote_int(name: str) -> Optional[int]:
    value = _remote_ingest_setting(name)
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _remote_extensions(name: str, fallback: Iterable[str]) -> List[str]:
    value = _remote_ingest_setting(name)
    if value is None:
        return [item for item in fallback]
    if isinstance(value, (list, tuple, set)):
        candidates = value
    elif isinstance(value, str):
        candidates = [piece.strip() for piece in value.replace("\n", ",").split(",")]
    else:
        return [item for item in fallback]
    normalized: List[str] = []
    for entry in candidates:
        if not entry:
            continue
        normalized.append(str(entry).strip().lower())
    return normalized if normalized else [item for item in fallback]


REMOTE_CORS_ORIGIN = _remote_ingest_setting("TRANSCODER_CORS_ORIGIN")
DEFAULT_CORS_ORIGIN = os.getenv("TRANSCODER_CORS_ORIGIN", "*")
if isinstance(REMOTE_CORS_ORIGIN, str) and REMOTE_CORS_ORIGIN.strip():
    DEFAULT_CORS_ORIGIN = REMOTE_CORS_ORIGIN.strip()

REMOTE_ENABLE_PUT = _remote_bool("INGEST_ENABLE_PUT")
if REMOTE_ENABLE_PUT is None:
    DEFAULT_ENABLE_PUT = _env_bool("INGEST_ENABLE_PUT", True)
else:
    DEFAULT_ENABLE_PUT = bool(REMOTE_ENABLE_PUT)

REMOTE_ENABLE_DELETE = _remote_bool("INGEST_ENABLE_DELETE")
if REMOTE_ENABLE_DELETE is None:
    DEFAULT_ENABLE_DELETE = _env_bool("INGEST_ENABLE_DELETE", True)
else:
    DEFAULT_ENABLE_DELETE = bool(REMOTE_ENABLE_DELETE)

REMOTE_CACHE_MAX_AGE = _remote_int("INGEST_CACHE_MAX_AGE")
if REMOTE_CACHE_MAX_AGE is None:
    DEFAULT_CACHE_MAX_AGE = max(_env_int("INGEST_CACHE_MAX_AGE", 30), 0)
else:
    DEFAULT_CACHE_MAX_AGE = max(REMOTE_CACHE_MAX_AGE, 0)

DEFAULT_CACHE_EXTENSIONS = tuple(
    _remote_extensions(
        "INGEST_CACHE_EXTENSIONS",
        _env_csv(
            "INGEST_CACHE_EXTENSIONS",
            [
                "mp4",
                "m4s",
                "m4a",
                "m4v",
                "vtt",
                "ts",
            ],
        ),
    )
)
DEFAULT_RETENTION_SEGMENTS = max(
    _env_int("INGEST_RETENTION_SEGMENTS", retention_default),
    0,
)


def build_default_config() -> Dict[str, Any]:
    """Return the base configuration mapping for the ingest service."""

    cfg: Dict[str, Any] = {
        "TRANSCODER_OUTPUT": DEFAULT_OUTPUT,
        "TRANSCODER_CORS_ORIGIN": DEFAULT_CORS_ORIGIN,
        "INGEST_ENABLE_PUT": DEFAULT_ENABLE_PUT,
        "INGEST_ENABLE_DELETE": DEFAULT_ENABLE_DELETE,
        "INGEST_CACHE_MAX_AGE": DEFAULT_CACHE_MAX_AGE,
        "INGEST_CACHE_EXTENSIONS": DEFAULT_CACHE_EXTENSIONS,
        "INGEST_RETENTION_SEGMENTS": DEFAULT_RETENTION_SEGMENTS,
        "TRANSCODER_INTERNAL_TOKEN": os.getenv("TRANSCODER_INTERNAL_TOKEN"),
    }
    return cfg


__all__ = ["build_default_config"]
