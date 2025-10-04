"""Configuration helpers for the transcoder microservice."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

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

_shared_output = os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
_explicit_output = os.getenv("TRANSCODER_OUTPUT")
if _explicit_output:
    DEFAULT_OUTPUT = _explicit_output
elif _shared_output:
    DEFAULT_OUTPUT = _shared_output
else:
    DEFAULT_OUTPUT = str(CORE_ROOT / "ingest" / "out")
DEFAULT_BASENAME = os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
DEFAULT_PUBLISH_BASE_URL = os.getenv("TRANSCODER_PUBLISH_BASE_URL")
DEFAULT_LOCAL_MEDIA_BASE_URL = os.getenv(
    "TRANSCODER_LOCAL_MEDIA_BASE_URL",
    "http://localhost:5005/media/",
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
