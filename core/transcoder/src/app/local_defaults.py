"""Local configuration defaults that seed the transcoder settings."""
from __future__ import annotations

import os
from pathlib import Path

from ..utils import coerce_int
from .remote_overrides import remote_bool, remote_str

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORE_ROOT = PROJECT_ROOT / "core"
DEFAULT_INPUT = os.getenv("TRANSCODER_INPUT", "/media/tmp/pulpfiction.mkv")

_shared_output = os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
_explicit_output = os.getenv("TRANSCODER_OUTPUT")
_remote_output = remote_str("TRANSCODER_LOCAL_OUTPUT_DIR")
if _remote_output:
    DEFAULT_OUTPUT = _remote_output
elif _explicit_output:
    DEFAULT_OUTPUT = _explicit_output
elif _shared_output:
    DEFAULT_OUTPUT = _shared_output
else:
    DEFAULT_OUTPUT = str(Path.home() / "transcode_data")

DEFAULT_BASENAME = (
    remote_str("TRANSCODER_OUTPUT_BASENAME")
    or os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video")
)

DEFAULT_PUBLISH_BASE_URL = (
    remote_str("TRANSCODER_PUBLISH_BASE_URL")
    or os.getenv("TRANSCODER_PUBLISH_BASE_URL")
    or "http://localhost:5005/media/"
)

DEFAULT_CORS_ORIGIN = (
    remote_str("TRANSCODER_CORS_ORIGIN")
    or os.getenv("TRANSCODER_CORS_ORIGIN")
    or "*"
)

_auto_keyframing_env = os.getenv("TRANSCODER_AUTO_KEYFRAMING")
remote_auto_keyframing = remote_bool("TRANSCODER_AUTO_KEYFRAMING")
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

DEFAULT_STATUS_PREFIX = os.getenv("TRANSCODER_STATUS_PREFIX", "transcoder")
DEFAULT_STATUS_NAMESPACE = os.getenv("TRANSCODER_STATUS_NAMESPACE", "transcoder")
DEFAULT_STATUS_KEY = os.getenv("TRANSCODER_STATUS_KEY", "status")
DEFAULT_STATUS_CHANNEL = os.getenv(
    "TRANSCODER_STATUS_CHANNEL",
    "transcoder:transcoder:status",
)

DEFAULT_STATUS_TTL_SECONDS = coerce_int(
    os.getenv("TRANSCODER_STATUS_TTL_SECONDS"),
    30,
)

DEFAULT_STATUS_HEARTBEAT_SECONDS = coerce_int(
    os.getenv("TRANSCODER_STATUS_HEARTBEAT_SECONDS"),
    5,
)

_debug_endpoint_env = os.getenv("TRANSCODER_DEBUG_ENDPOINT_ENABLED")
remote_debug_endpoint = remote_bool("TRANSCODER_DEBUG_ENDPOINT_ENABLED")
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

_remote_task_timeout = remote_str("CELERY_TASK_TIMEOUT_SECONDS")
DEFAULT_CELERY_TASK_TIMEOUT_SECONDS = coerce_int(
    _remote_task_timeout
    if _remote_task_timeout is not None
    else os.getenv("CELERY_TASK_TIMEOUT_SECONDS"),
    10,
)

__all__ = [
    "CORE_ROOT",
    "DEFAULT_AUTO_KEYFRAMING",
    "DEFAULT_BASENAME",
    "DEFAULT_CELERY_AV_QUEUE",
    "DEFAULT_CELERY_RESULT_BACKEND",
    "DEFAULT_CORS_ORIGIN",
    "DEFAULT_DEBUG_ENDPOINT_ENABLED",
    "DEFAULT_INPUT",
    "DEFAULT_OUTPUT",
    "DEFAULT_PUBLISH_BASE_URL",
    "DEFAULT_REDIS_URL",
    "DEFAULT_STATUS_CHANNEL",
    "DEFAULT_STATUS_HEARTBEAT_SECONDS",
    "DEFAULT_STATUS_KEY",
    "DEFAULT_STATUS_NAMESPACE",
    "DEFAULT_STATUS_PREFIX",
    "DEFAULT_STATUS_REDIS_URL",
    "DEFAULT_STATUS_TTL_SECONDS",
    "DEFAULT_CELERY_TASK_TIMEOUT_SECONDS",
    "PROJECT_ROOT",
]
