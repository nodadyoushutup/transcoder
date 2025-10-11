"""Celery application factory for the API service."""
from __future__ import annotations

import os
from typing import Optional

from celery import Celery
from flask import Flask
from kombu import Queue

try:
    from dotenv import find_dotenv, load_dotenv
except ModuleNotFoundError:  # pragma: no cover - optional dependency outside dev
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


celery: Celery = Celery("api")
celery.set_default()
celery.conf.beat_scheduler = "core.api.src.celery_app.scheduler.SettingsBackedScheduler"

# Backwards-compatibility alias for legacy imports.
celery_app = celery

_bound_app: Flask | None = None
_configured = False


def _resolve_redis_url(app: Flask | None) -> Optional[str]:
    """Return a Redis URL using the current Flask application context."""

    redis_service = app.extensions.get("redis_service") if app else None
    if redis_service and getattr(redis_service, "redis_url", None):
        return redis_service.redis_url
    return os.getenv("REDIS_URL")


def _queue_names(app: Flask) -> tuple[str, str, str]:
    default_queue = (
        app.config.get("CELERY_DEFAULT_QUEUE")
        or os.getenv("CELERY_DEFAULT_QUEUE")
        or "transcoder"
    )
    library_queue = (
        app.config.get("CELERY_LIBRARY_QUEUE")
        or os.getenv("CELERY_LIBRARY_QUEUE")
        or "library_sections"
    )
    image_cache_queue = (
        app.config.get("CELERY_IMAGE_CACHE_QUEUE")
        or os.getenv("CELERY_IMAGE_CACHE_QUEUE")
        or "library_images"
    )
    return str(default_queue), str(library_queue), str(image_cache_queue)


def _configure_routes(default_queue: str, library_queue: str, image_cache_queue: str) -> None:
    routes: dict[str, dict[str, str]] = {}

    routes["core.api.src.celery_app.tasks.library.build_section_snapshot_task"] = {"queue": library_queue}
    routes["core.api.src.celery_app.tasks.library.fetch_section_snapshot_chunk"] = {"queue": library_queue}
    routes["core.api.src.celery_app.tasks.library.cache_section_images_task"] = {"queue": image_cache_queue}
    routes["core.api.src.celery_app.tasks.library.cache_single_image_task"] = {"queue": image_cache_queue}

    existing_routes = celery.conf.get("task_routes") or {}
    existing_routes.update(routes)
    celery.conf.task_routes = existing_routes


def init_celery(app: Flask | None = None) -> Celery:
    """Configure Celery to run with the Flask application context."""

    global _bound_app, _configured

    if app is not None:
        flask_app = app
        _bound_app = app
    else:
        flask_app = _bound_app
        if flask_app is None:
            from ..app import create_app  # local import to avoid circular dependency

            flask_app = create_app()
            _bound_app = flask_app

    if _configured and flask_app.extensions.get("celery") is celery:
        return celery

    broker_url = (
        flask_app.config.get("CELERY_BROKER_URL")
        or os.getenv("CELERY_BROKER_URL")
        or _resolve_redis_url(flask_app)
        or "redis://127.0.0.1:6379/0"
    )
    result_backend = (
        flask_app.config.get("CELERY_RESULT_BACKEND")
        or os.getenv("CELERY_RESULT_BACKEND")
        or broker_url
    )

    celery.conf.update(
        broker_url=broker_url,
        result_backend=result_backend,
        task_ignore_result=True,
    )

    default_queue, library_queue, image_cache_queue = _queue_names(flask_app)
    task_queues = [
        Queue(default_queue, routing_key=f"{default_queue}"),
    ]
    if library_queue not in {default_queue}:
        task_queues.append(Queue(library_queue, routing_key="library.sections"))
    if image_cache_queue not in {default_queue, library_queue}:
        task_queues.append(Queue(image_cache_queue, routing_key="library.images"))
    celery.conf.task_default_queue = default_queue
    celery.conf.task_queues = tuple(task_queues)
    _configure_routes(default_queue, library_queue, image_cache_queue)

    class FlaskContextTask(celery.Task):
        abstract = True

        def __call__(self, *args, **kwargs):
            with flask_app.app_context():
                return super().__call__(*args, **kwargs)

    celery.Task = FlaskContextTask  # type: ignore[assignment]
    celery.autodiscover_tasks(["core.api.src.celery_app.tasks"])

    from ..services.task_monitor import TaskMonitorService

    celery.conf.beat_schedule_refresh_interval = int(
        celery.conf.get("beat_schedule_refresh_interval", 15) or 15
    )
    settings_service = flask_app.extensions.get("settings_service")
    redis_service = flask_app.extensions.get("redis_service")
    inspect_timeout_env = (
        flask_app.config.get("CELERY_INSPECT_TIMEOUT") or os.getenv("CELERY_INSPECT_TIMEOUT")
    )

    inspect_timeout_value: float | None = None
    if inspect_timeout_env:
        try:
            inspect_timeout_value = float(inspect_timeout_env)
        except (TypeError, ValueError):
            inspect_timeout_value = None

    if settings_service is not None:
        monitor = TaskMonitorService(
            celery,
            settings_service,
            redis_service=redis_service,
            inspect_timeout=inspect_timeout_value,
        )
        flask_app.extensions["task_monitor"] = monitor
        with flask_app.app_context():
            monitor.reload_schedule()
            celery.conf.beat_schedule_refresh_interval = monitor.refresh_interval_seconds()

    flask_app.extensions["celery_app"] = celery
    flask_app.extensions["celery"] = celery

    _configured = True
    return celery


def get_celery() -> Celery:
    """Return the configured Celery application."""

    return init_celery()


def get_flask_app() -> Flask:
    """Return the Flask application currently bound to Celery, creating one if needed."""

    if _bound_app is None:
        init_celery()
    assert _bound_app is not None
    return _bound_app


__all__ = ["celery", "celery_app", "get_celery", "get_flask_app", "init_celery"]
