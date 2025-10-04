"""Configuration helpers for the ingest service."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Iterable, List

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
    values = [value.strip().lower() for value in raw.split(",") if value.strip()]
    return values if values else [item for item in default]


SERVICE_ROOT = Path(__file__).resolve().parents[1]
SHARED_OUTPUT = os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
DEFAULT_OUTPUT = (
    os.getenv("INGEST_OUTPUT_DIR")
    or os.getenv("TRANSCODER_OUTPUT")
    or SHARED_OUTPUT
    or str(SERVICE_ROOT / "out")
)
DEFAULT_CORS_ORIGIN = os.getenv("TRANSCODER_CORS_ORIGIN", "*")
DEFAULT_ENABLE_PUT = _env_bool("INGEST_ENABLE_PUT", True)
DEFAULT_ENABLE_DELETE = _env_bool("INGEST_ENABLE_DELETE", True)
DEFAULT_CACHE_MAX_AGE = max(_env_int("INGEST_CACHE_MAX_AGE", 30), 0)
DEFAULT_CACHE_EXTENSIONS = tuple(
    _env_csv(
        "INGEST_CACHE_EXTENSIONS",
        [
            "mpd",
            "mp4",
            "m4s",
            "m4a",
            "m4v",
            "m3u8",
            "ts",
        ],
    )
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
    }
    return cfg


__all__ = ["build_default_config"]
