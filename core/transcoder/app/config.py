"""Configuration helpers for the transcoder microservice."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORE_ROOT = PROJECT_ROOT / "core"
DEFAULT_INPUT = os.getenv("TRANSCODER_INPUT", "/media/tmp/wicked.mkv")
DEFAULT_OUTPUT = os.getenv(
    "TRANSCODER_OUTPUT",
    str(CORE_ROOT / "out"),
)
DEFAULT_BASENAME = os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
DEFAULT_PUBLISH_BASE_URL = os.getenv("TRANSCODER_PUBLISH_BASE_URL")
DEFAULT_LOCAL_MEDIA_BASE_URL = os.getenv(
    "TRANSCODER_LOCAL_MEDIA_BASE_URL",
    "http://localhost:5001/media/",
)
DEFAULT_CORS_ORIGIN = os.getenv("TRANSCODER_CORS_ORIGIN", "*")


def build_default_config() -> Dict[str, Any]:
    """Return the base configuration mapping for the microservice."""

    cfg: Dict[str, Any] = {
        "TRANSCODER_INPUT": DEFAULT_INPUT,
        "TRANSCODER_OUTPUT": DEFAULT_OUTPUT,
        "TRANSCODER_OUTPUT_BASENAME": DEFAULT_BASENAME,
        "TRANSCODER_PUBLISH_BASE_URL": DEFAULT_PUBLISH_BASE_URL,
        "TRANSCODER_LOCAL_MEDIA_BASE_URL": DEFAULT_LOCAL_MEDIA_BASE_URL,
        "TRANSCODER_CORS_ORIGIN": DEFAULT_CORS_ORIGIN,
    }
    return cfg


__all__ = ["build_default_config"]
