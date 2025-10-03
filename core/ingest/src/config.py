"""Configuration helpers for the ingest service."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = os.getenv(
    "TRANSCODER_OUTPUT",
    str(SERVICE_ROOT / "out"),
)
DEFAULT_CORS_ORIGIN = os.getenv("TRANSCODER_CORS_ORIGIN", "*")
DEFAULT_ENABLE_PUT = _env_bool("INGEST_ENABLE_PUT", True)
DEFAULT_ENABLE_DELETE = _env_bool("INGEST_ENABLE_DELETE", True)


def build_default_config() -> Dict[str, Any]:
    """Return the base configuration mapping for the ingest service."""

    cfg: Dict[str, Any] = {
        "TRANSCODER_OUTPUT": DEFAULT_OUTPUT,
        "TRANSCODER_CORS_ORIGIN": DEFAULT_CORS_ORIGIN,
        "INGEST_ENABLE_PUT": DEFAULT_ENABLE_PUT,
        "INGEST_ENABLE_DELETE": DEFAULT_ENABLE_DELETE,
    }
    return cfg


__all__ = ["build_default_config"]
