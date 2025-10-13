"""Root package for the transcoder service codebase."""
from __future__ import annotations

from .app import create_app
from .celery_app import celery, init_celery
from .celery_app.tasks import start_transcode_task, stop_transcode_task
from .engine import TranscoderController, TranscoderStatus, TranscoderStatusBroadcaster
from .publisher import UploadManager, WatchdogConfig, main as run_publisher, run_watchdog
from .routes import api_bp

__all__ = [
    "create_app",
    "celery",
    "init_celery",
    "start_transcode_task",
    "stop_transcode_task",
    "api_bp",
    "TranscoderController",
    "TranscoderStatus",
    "TranscoderStatusBroadcaster",
    "UploadManager",
    "WatchdogConfig",
    "run_watchdog",
    "run_publisher",
]
