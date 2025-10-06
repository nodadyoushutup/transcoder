"""Celery task definitions for the transcoder microservice."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any, Mapping

from celery.utils.log import get_task_logger
from flask import current_app

from .celery_app import celery

LOGGER = get_task_logger(__name__)


def _build_settings(app, overrides: Mapping[str, Any]):
    from .controllers import transcode as transcode_controller

    return transcode_controller._build_settings(app.config, overrides)


def _status_payload(config: Mapping[str, Any]) -> Mapping[str, Any]:
    from .controllers import transcode as transcode_controller

    return transcode_controller._status_payload(config)


@celery.task(bind=True, name="transcoder.start_av")
def start_transcode_task(self, overrides: Mapping[str, Any]) -> Mapping[str, Any]:
    """Start audio/video transcoding via Celery."""

    app = current_app
    controller = app.extensions["transcoder_controller"]

    settings = _build_settings(app, overrides)
    publish_base_url = overrides.get("publish_base_url")
    if not publish_base_url:
        publish_base_url = _status_payload(app.config).get("publish_base_url")
    force_new = overrides.get("force_new_connection")
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
        force_new_connection=force_new,
        subtitle_metadata=subtitle_meta,
        session=overrides.get("session") if isinstance(overrides.get("session"), Mapping) else None,
    )

    status_payload = _status_payload(app.config)
    session_snapshot = status_payload.get("session") if isinstance(status_payload, Mapping) else {}
    LOGGER.info(
        "[task:%s] AV transcode queued (running=%s)",
        self.request.id,
        session_snapshot.get("running") if isinstance(session_snapshot, Mapping) else None,
    )
    return {
        "status": HTTPStatus.ACCEPTED,
        "payload": status_payload,
    }


@celery.task(bind=True, name="transcoder.extract_subtitles")
def extract_subtitles_task(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
    """Extract subtitles asynchronously via Celery."""

    app = current_app
    controller = app.extensions["transcoder_controller"]

    settings = _build_settings(app, payload)
    publish_base_url = payload.get("publish_base_url")
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
    status_payload = _status_payload(app.config)
    LOGGER.info(
        "[task:%s] Subtitle extraction finished (%d track(s))",
        self.request.id,
        len(tracks),
    )
    return {
        "status": HTTPStatus.OK,
        "tracks": tracks,
        "payload": status_payload,
    }


@celery.task(bind=True, name="transcoder.stop_av")
def stop_transcode_task(self) -> Mapping[str, Any]:
    """Stop the active transcoder run via Celery."""

    app = current_app
    controller = app.extensions["transcoder_controller"]

    LOGGER.info("[task:%s] Stop requested", self.request.id)
    stopped = controller.stop()
    status_payload = _status_payload(app.config)

    if stopped:
        LOGGER.info("[task:%s] Transcoder stopped", self.request.id)
    else:
        LOGGER.info("[task:%s] Stop requested but no active run", self.request.id)

    return {
        "status": HTTPStatus.OK,
        "stopped": bool(stopped),
        "payload": status_payload,
    }


__all__ = ["start_transcode_task", "extract_subtitles_task", "stop_transcode_task"]
