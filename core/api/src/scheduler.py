"""Custom Celery scheduler that sources periodic jobs from system settings."""
from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any, Dict, Iterable

from celery.beat import Scheduler
from celery.schedules import schedule as celery_schedule

from .celery_app import get_flask_app

logger = logging.getLogger(__name__)


class SettingsBackedScheduler(Scheduler):
    """Periodically pull beat schedule definitions from the database."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._flask_app = get_flask_app()
        self._settings_service = None
        self._config: Dict[str, Any] | None = None
        self._last_refresh = 0.0
        self._refresh_interval = int(self.app.conf.get("beat_schedule_refresh_interval", 15) or 15)
        self._refresh_interval = max(5, min(self._refresh_interval, 300))
        if self._flask_app is not None:
            self._settings_service = self._flask_app.extensions.get("settings_service")
        self._reload_schedule(initial=True)

    def _reload_schedule(self, *, initial: bool = False) -> None:
        if not self._settings_service:
            if initial:
                logger.warning("Settings service unavailable; no periodic tasks loaded")
            return

        with self._flask_app.app_context():
            config = self._settings_service.get_sanitized_tasks_settings()

        if not initial and config == self._config:
            return

        self._config = config
        jobs = config.get("beat_jobs", [])
        refresh_interval = config.get("refresh_interval_seconds")
        try:
            if refresh_interval:
                value = int(refresh_interval)
                self._refresh_interval = max(5, min(value, 300))
        except (TypeError, ValueError):
            pass

        new_schedule: Dict[str, Any] = {}
        for entry in jobs if isinstance(jobs, Iterable) else []:
            if not isinstance(entry, dict):
                continue
            if not entry.get("enabled", True):
                continue
            job_id = str(entry.get("id") or entry.get("task") or "").strip()
            task_name = str(entry.get("task") or "").strip()
            if not job_id or not task_name:
                continue
            try:
                seconds = int(entry.get("schedule_seconds") or 0)
            except (TypeError, ValueError):
                seconds = 0
            if seconds <= 0:
                continue
            schedule = celery_schedule(run_every=timedelta(seconds=seconds))
            raw_args = entry.get("args")
            if isinstance(raw_args, (list, tuple)):
                args = tuple(raw_args)
            elif raw_args is None:
                args = ()
            else:
                args = (raw_args,)
            raw_kwargs = entry.get("kwargs")
            kwargs = dict(raw_kwargs) if isinstance(raw_kwargs, dict) else {}
            options: Dict[str, Any] = {}
            queue = entry.get("queue")
            if isinstance(queue, str) and queue.strip():
                options["queue"] = queue.strip()
            priority = entry.get("priority")
            try:
                if priority is not None:
                    options["priority"] = int(priority)
            except (TypeError, ValueError):
                pass
            new_schedule[job_id] = self.Entry(
                name=job_id,
                task=task_name,
                schedule=schedule,
                args=args,
                kwargs=kwargs,
                options=options,
            )

        self.schedule = new_schedule
        logger.info("Loaded %d periodic task(s) from system settings", len(new_schedule))

    def tick(self, *args, **kwargs):  # type: ignore[override]
        now = time.monotonic()
        if now - self._last_refresh >= self._refresh_interval:
            try:
                self._reload_schedule()
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Failed to refresh beat schedule: %s", exc)
            self._last_refresh = now
        return super().tick(*args, **kwargs)


__all__ = ["SettingsBackedScheduler"]
