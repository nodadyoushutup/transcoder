"""Celery application factory and configuration."""
from __future__ import annotations

import os
from typing import Optional

from celery import Celery
from kombu import Queue

try:
    from dotenv import find_dotenv, load_dotenv
except ModuleNotFoundError:  # pragma: no cover - optional outside dev
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


celery_app = Celery("transcoder")
celery_app.set_default()
celery_app.conf.beat_scheduler = "core.api.src.scheduler.SettingsBackedScheduler"

_bound_app = None
_configured = False


def _resolve_redis_url(app) -> Optional[str]:
    """Return the Redis URL from settings or environment."""

    redis_service = app.extensions.get("redis_service") if app else None
    if redis_service and getattr(redis_service, "redis_url", None):
        return redis_service.redis_url
    return os.getenv("REDIS_URL")


def init_celery(flask_app=None) -> Celery:
    """Configure Celery to run with the Flask application context."""

    global _bound_app, _configured

    if flask_app is not None:
        app = flask_app
        _bound_app = flask_app
    else:
        app = _bound_app
        if app is None:
            from . import create_app  # local import to avoid circular dependency

            app = create_app()
            _bound_app = app

    broker_url = os.getenv("CELERY_BROKER_URL") or _resolve_redis_url(app) or "redis://192.168.1.100:9379/0"
    result_backend = os.getenv("CELERY_RESULT_BACKEND") or broker_url
    default_queue = os.getenv("CELERY_DEFAULT_QUEUE", "transcoder")

    celery_app.conf.update(
        broker_url=broker_url,
        result_backend=result_backend,
        task_default_queue=default_queue,
        task_ignore_result=True,
    )

    library_queue = os.getenv("CELERY_LIBRARY_QUEUE", "library_sections")
    image_cache_queue = os.getenv("CELERY_IMAGE_CACHE_QUEUE", "library_images")
    task_queues = [Queue(default_queue, routing_key=f"{default_queue}")]
    if library_queue not in {default_queue}:
        task_queues.append(Queue(library_queue, routing_key="library.sections"))
    if image_cache_queue not in {default_queue, library_queue}:
        task_queues.append(Queue(image_cache_queue, routing_key="library.images"))
    celery_app.conf.task_queues = tuple(task_queues)

    routes = {
        "src.tasks.library.build_section_snapshot_task": {"queue": library_queue},
        "src.tasks.library.fetch_section_snapshot_chunk": {"queue": library_queue},
        "src.tasks.library.cache_section_images_task": {"queue": image_cache_queue},
        "src.tasks.library.cache_single_image_task": {"queue": image_cache_queue},
    }
    # Backwards compatibility for legacy task names that may still be queued.
    routes.setdefault(
        "core.api.src.tasks.library.build_section_snapshot_task",
        {"queue": library_queue},
    )
    routes.setdefault(
        "core.api.src.tasks.library.fetch_section_snapshot_chunk",
        {"queue": library_queue},
    )
    existing_routes = celery_app.conf.get("task_routes") or {}
    existing_routes.update(routes)
    celery_app.conf.task_routes = existing_routes

    class FlaskContextTask(celery_app.Task):
        def __call__(self, *args, **kwargs):  # type: ignore[override]
            with app.app_context():
                return super().__call__(*args, **kwargs)

    celery_app.Task = FlaskContextTask  # type: ignore[assignment]
    celery_app.autodiscover_tasks(["core.api.src.tasks"])

    from .services.task_monitor import TaskMonitorService

    celery_app.conf.beat_schedule_refresh_interval = int(
        celery_app.conf.get("beat_schedule_refresh_interval", 15) or 15
    )
    settings_service = app.extensions.get("settings_service")
    redis_service = app.extensions.get("redis_service")
    inspect_timeout_env = os.getenv("CELERY_INSPECT_TIMEOUT")
    inspect_timeout_value = None
    if inspect_timeout_env:
        try:
            inspect_timeout_value = float(inspect_timeout_env)
        except ValueError:
            inspect_timeout_value = None
    if settings_service is not None:
        monitor = TaskMonitorService(
            celery_app,
            settings_service,
            redis_service=redis_service,
            inspect_timeout=inspect_timeout_value,
        )
        app.extensions["task_monitor"] = monitor
        # Task monitor loads settings via SQLAlchemy, which requires a Flask
        # application context. Ensure we refresh the schedule inside one so the
        # worker can boot outside of the web process.
        with app.app_context():
            monitor.reload_schedule()
            celery_app.conf.beat_schedule_refresh_interval = monitor.refresh_interval_seconds()

    app.extensions.setdefault("celery_app", celery_app)
    _configured = True
    return celery_app


def get_flask_app():
    """Return the Flask application associated with Celery, if available."""

    if _bound_app is None:
        init_celery()
    return _bound_app


init_celery()


__all__ = ["celery_app", "init_celery", "get_flask_app"]
