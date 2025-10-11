"""Celery task for subtitle extraction."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, Mapping

from celery.utils.log import get_task_logger
from flask import current_app

from .. import celery
from ._utils import build_settings, status_payload

LOGGER = get_task_logger(__name__)


@celery.task(bind=True, name="transcoder.extract_subtitles")
def extract_subtitles_task(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
    """Extract subtitles asynchronously via Celery."""

    app = current_app
    controller = app.extensions["transcoder_controller"]

    settings = build_settings(app, payload)
    publish_base_raw = payload.get("publish_base_url")
    publish_base_url = publish_base_raw.strip() if isinstance(publish_base_raw, str) else publish_base_raw
    subtitle_meta = payload.get("subtitle") if isinstance(payload.get("subtitle"), Mapping) else None

    if not subtitle_meta:
        return {"status": HTTPStatus.BAD_REQUEST, "error": "subtitle metadata is required"}

    LOGGER.info(
        "[task:%s] Subtitle extraction started (rating=%s part=%s)",
        self.request.id,
        subtitle_meta.get("rating_key"),
        subtitle_meta.get("part_id"),
    )

    tracks = controller.prepare_subtitles(
        settings,
        publish_base_url,
        subtitle_meta,
    )
    payload_response = status_payload(app)
    LOGGER.info(
        "[task:%s] Subtitle extraction finished (%d track(s))",
        self.request.id,
        len(tracks),
    )
    return {
        "status": HTTPStatus.OK,
        "tracks": tracks,
        "payload": payload_response,
    }


__all__ = ["extract_subtitles_task"]
