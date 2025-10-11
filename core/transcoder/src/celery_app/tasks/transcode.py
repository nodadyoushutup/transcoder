"""Celery tasks that drive audio/video transcoding."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, Mapping

from celery.utils.log import get_task_logger
from flask import current_app

from .. import celery
from ._utils import build_settings, status_payload

LOGGER = get_task_logger(__name__)


@celery.task(bind=True, name="transcoder.start_av")
def start_transcode_task(self, overrides: Mapping[str, Any]) -> Mapping[str, Any]:
    """Start audio/video transcoding via Celery."""

    app = current_app
    controller = app.extensions["transcoder_controller"]

    settings = build_settings(app, overrides)
    publish_base_raw = overrides.get("publish_base_url")
    publish_base_url = publish_base_raw.strip() if isinstance(publish_base_raw, str) else publish_base_raw
    subtitle_meta = overrides.get("subtitle") if isinstance(overrides.get("subtitle"), Mapping) else None

    LOGGER.info(
        "[task:%s] Starting AV transcode (rating=%s part=%s)",
        self.request.id,
        subtitle_meta.get("rating_key") if subtitle_meta else None,
        subtitle_meta.get("part_id") if subtitle_meta else None,
    )

    controller.start(
        settings,
        publish_base_url,
        subtitle_metadata=subtitle_meta,
        session=overrides.get("session") if isinstance(overrides.get("session"), Mapping) else None,
    )

    payload = status_payload(app)
    session_snapshot = payload.get("session") if isinstance(payload, Mapping) else {}
    LOGGER.info(
        "[task:%s] AV transcode queued (running=%s)",
        self.request.id,
        session_snapshot.get("running") if isinstance(session_snapshot, Mapping) else None,
    )
    return {
        "status": HTTPStatus.ACCEPTED,
        "payload": payload,
    }


__all__ = ["start_transcode_task"]
