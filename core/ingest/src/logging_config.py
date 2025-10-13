"""Logging helpers for the ingest service."""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

_LOG_FILE: Optional[Path] = None
_CONFIGURED = False


def configure_logging(prefix: str = "ingest", *, log_dir: Optional[Path] = None) -> Path:
    """Configure structured logging for the ingest application."""

    global _CONFIGURED, _LOG_FILE

    if _CONFIGURED and _LOG_FILE is not None:
        return _LOG_FILE

    service_root = Path(__file__).resolve().parents[2]
    env_dir = os.getenv("INGEST_LOG_DIR") or os.getenv("TRANSCODER_BACKEND_LOG_DIR")
    log_directory = Path(env_dir).expanduser() if env_dir else service_root / "logs"
    if log_dir is not None:
        log_directory = Path(log_dir)
    log_directory.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    log_file = log_directory / f"{prefix}-{timestamp}.log"

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    formatter = logging.Formatter(
        fmt="%(asctime)s.%(msecs)03d %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)

    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

    _CONFIGURED = True
    _LOG_FILE = log_file
    root_logger.info("Logging initialized at %s", log_file)
    return log_file


def current_log_file() -> Optional[Path]:
    """Return the most recent log file configured via ``configure_logging``."""

    return _LOG_FILE


__all__ = ["configure_logging", "current_log_file"]
