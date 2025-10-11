"""Helpers for manipulating transcoder sessions and controller state."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Mapping, Optional

from flask import Flask, Request

from transcoder import EncoderSettings

from ..app.logging import current_log_file
from ..engine import TranscoderController
from ..utils import ensure_trailing_slash
from .internal_restart import require_internal_token as verify_internal_token
from .internal_restart import schedule_restart as schedule_internal_restart
from .settings_builder import build_encoder_settings


class TranscodeRuntime:
    """Domain-facing runtime helpers shared by HTTP and Celery surfaces."""

    def __init__(self, app: Flask) -> None:
        controller = app.extensions.get("transcoder_controller")
        if not isinstance(controller, TranscoderController):
            raise RuntimeError("Transcoder controller not initialised on Flask app.")
        self._app = app
        self._controller = controller

    @property
    def app(self) -> Flask:
        return self._app

    @property
    def controller(self) -> TranscoderController:
        return self._controller

    def status_payload(self) -> Mapping[str, Any]:
        status = self._controller.status(local_base_override=self._effective_local_media_base())
        log_path = current_log_file()
        session = status.to_session(
            origin="transcoder",
            log_file=str(log_path) if log_path else None,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        return {"session": session, "metadata": {}}

    def build_settings(self, overrides: Mapping[str, Any]) -> EncoderSettings:
        return build_encoder_settings(self._app.config, overrides)

    def _effective_local_media_base(self) -> Optional[str]:
        configured = self._app.config.get("TRANSCODER_LOCAL_MEDIA_BASE_URL")
        if isinstance(configured, str):
            return ensure_trailing_slash(configured)
        return None

class TranscodeSessionService:
    """Application-facing utilities for manipulating the transcoder controller."""

    def __init__(self, runtime: TranscodeRuntime) -> None:
        self._runtime = runtime

    @property
    def runtime(self) -> TranscodeRuntime:
        return self._runtime

    # ------------------------------------------------------------------
    # Controller accessors
    # ------------------------------------------------------------------
    @property
    def controller(self) -> TranscoderController:
        return self._runtime.controller

    # ------------------------------------------------------------------
    # Status helpers
    # ------------------------------------------------------------------
    def status_payload(self) -> Mapping[str, Any]:
        return self._runtime.status_payload()

    # ------------------------------------------------------------------
    # Restart helpers
    # ------------------------------------------------------------------
    def require_internal_token(self, request: Request):
        return verify_internal_token(self._runtime.app, request)

    def schedule_restart(self) -> None:
        schedule_internal_restart(self._runtime.app)

    # ------------------------------------------------------------------
    # Settings helpers
    # ------------------------------------------------------------------
    def build_settings(self, overrides: Mapping[str, Any]) -> EncoderSettings:
        return self._runtime.build_settings(overrides)

def get_runtime(app: Flask) -> TranscodeRuntime:
    runtime = app.extensions.get("transcode_runtime")
    if isinstance(runtime, TranscodeRuntime):
        return runtime
    runtime = TranscodeRuntime(app)
    app.extensions["transcode_runtime"] = runtime
    return runtime


def init_transcode_services(app: Flask) -> TranscodeSessionService:
    service = app.extensions.get("transcode_session_service")
    if isinstance(service, TranscodeSessionService):
        return service
    runtime = get_runtime(app)
    service = TranscodeSessionService(runtime)
    app.extensions["transcode_session_service"] = service
    return service


def get_session_service(app: Flask) -> TranscodeSessionService:
    service = app.extensions.get("transcode_session_service")
    if isinstance(service, TranscodeSessionService):
        return service
    return init_transcode_services(app)


__all__ = [
    "TranscodeRuntime",
    "TranscodeSessionService",
    "get_runtime",
    "get_session_service",
    "init_transcode_services",
]
