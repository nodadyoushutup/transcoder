"""Celery application factory for the transcoder service."""
from __future__ import annotations

from celery import Celery

celery = Celery("transcoder")


def init_celery(app) -> Celery:
    """Bind Celery to the Flask app and configure queues."""

    celery.conf.update(
        broker_url=app.config["CELERY_BROKER_URL"],
        result_backend=app.config["CELERY_RESULT_BACKEND"],
        task_default_queue=app.config["CELERY_TASK_DEFAULT_QUEUE"],
        task_acks_late=True,
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        worker_hijack_root_logger=False,
    )

    TaskBase = celery.Task

    class ContextTask(TaskBase):
        abstract = True

        def __call__(self, *args, **kwargs):
            with app.app_context():
                return TaskBase.__call__(self, *args, **kwargs)

    celery.Task = ContextTask
    app.extensions["celery"] = celery
    return celery


__all__ = ["celery", "init_celery"]
