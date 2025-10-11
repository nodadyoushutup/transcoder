"""Celery task for managing the transcoder lifecycle."""
from __future__ import annotations

from http import HTTPStatus
from typing import Mapping

from celery.utils.log import get_task_logger
from flask import current_app

from .. import celery
from ._utils import status_payload

LOGGER = get_task_logger(__name__)


@celery.task(bind=True, name="transcoder.stop_av")
def stop_transcode_task(self) -> Mapping[str, object]:
    """Stop the active transcoder run via Celery."""

    app = current_app
    controller = app.extensions["transcoder_controller"]

    LOGGER.info("[task:%s] Stop requested", self.request.id)
    stopped = controller.stop()
    payload = status_payload(app)

    if stopped:
        LOGGER.info("[task:%s] Transcoder stopped", self.request.id)
    else:
        LOGGER.info("[task:%s] Stop requested but no active run", self.request.id)

    return {
        "status": HTTPStatus.OK,
        "stopped": bool(stopped),
        "payload": payload,
    }


__all__ = ["stop_transcode_task"]
