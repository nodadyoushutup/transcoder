"""Logging helpers for the transcoder service."""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

_LOG_FILE: Optional[Path] = None
_CONFIGURED = False


def configure_logging(prefix: str, *, log_dir: Optional[Path] = None) -> Path:
    """Configure root logging to write to the service's log directory."""

    global _CONFIGURED, _LOG_FILE

    if _CONFIGURED and _LOG_FILE is not None:
        return _LOG_FILE

    service_root = Path(__file__).resolve().parents[2]
    env_dir = os.getenv("TRANSCODER_SERVICE_LOG_DIR")
    log_directory = Path(env_dir).expanduser() if env_dir else service_root / "logs"
    if log_dir is not None:
        log_directory = Path(log_dir)
    log_directory.mkdir(parents=True, exist_ok=True)
    log_file = log_directory / f"{prefix}-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.log"

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)

    root.addHandler(file_handler)
    root.addHandler(console_handler)

    _CONFIGURED = True
    _LOG_FILE = log_file
    root.info("Logging to %s", log_file)
    return log_file


def current_log_file() -> Optional[Path]:
    """Return the most recent log file configured via ``configure_logging``."""

    return _LOG_FILE


__all__ = ["configure_logging", "current_log_file"]
