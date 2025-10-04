"""Helpers for inspecting and managing Celery background tasks."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Iterable, Mapping, Optional

from celery import Celery

try:  # pragma: no cover - optional dependency
    from eventlet.timeout import Timeout as EventletTimeout
except Exception:  # pragma: no cover - fallback when eventlet unavailable
    EventletTimeout = None

from .settings_service import SettingsService
from .redis_service import RedisService

logger = logging.getLogger(__name__)


class TaskMonitorService:
    """Expose task schedule management and runtime inspection for Celery."""

    def __init__(
        self,
        celery_app: Celery,
        settings_service: SettingsService,
        *,
        redis_service: Optional[RedisService] = None,
        inspect_timeout: float | None = None,
    ) -> None:
        self._celery = celery_app
        self._settings = settings_service
        self._startup_fired: set[str] = set()
        self._redis = redis_service
        timeout = inspect_timeout if inspect_timeout is not None else 0.5
        try:
            timeout = float(timeout)
        except (TypeError, ValueError):
            timeout = 0.5
        self._inspect_timeout = max(0.25, min(timeout, 3.0))

    # ------------------------------------------------------------------
    # Schedule helpers

    def current_settings(self) -> Dict[str, Any]:
        return self._settings.get_sanitized_tasks_settings()

    def _build_schedule(self) -> tuple[Dict[str, Any], Dict[str, Any]]:
        config = self.current_settings()
        schedule: Dict[str, Any] = {}
        for job in config.get("beat_jobs", []):
            if not job.get("enabled", True):
                continue
            try:
                seconds = int(job.get("schedule_seconds") or 0)
            except (TypeError, ValueError):
                seconds = 0
            if seconds <= 0:
                continue
            job_id = str(job.get("id") or job.get("task") or "").strip()
            task_name = str(job.get("task") or "").strip()
            if not job_id or not task_name:
                continue
            entry: Dict[str, Any] = {
                "task": task_name,
                "schedule": timedelta(seconds=seconds),
                "args": tuple(job.get("args") or ()),
                "kwargs": dict(job.get("kwargs") or {}),
            }
            options: Dict[str, Any] = {}
            queue = job.get("queue")
            if isinstance(queue, str) and queue.strip():
                options["queue"] = queue.strip()
            priority = job.get("priority")
            try:
                if priority is not None:
                    options["priority"] = int(priority)
            except (TypeError, ValueError):
                pass
            if options:
                entry["options"] = options
            schedule[job_id] = entry
        return config, schedule

    def reload_schedule(self) -> Dict[str, Any]:
        config, schedule = self._build_schedule()
        self._celery.conf.beat_schedule = schedule
        self._celery.conf.beat_schedule_refresh_interval = config.get(
            "refresh_interval_seconds",
            self._celery.conf.get("beat_schedule_refresh_interval", 15),
        )
        self._trigger_startup_jobs(config)
        return config

    def update_schedule(
        self,
        payload: Mapping[str, Any],
        *,
        updated_by: Optional[Any] = None,
    ) -> Dict[str, Any]:
        sanitized = self._settings.set_tasks_settings(payload, updated_by=updated_by)
        self.reload_schedule()
        self._celery.conf.beat_schedule_refresh_interval = sanitized.get(
            "refresh_interval_seconds",
            self._celery.conf.get("beat_schedule_refresh_interval", 15),
        )
        return sanitized

    def refresh_interval_seconds(self) -> int:
        settings = self.current_settings()
        try:
            return int(settings.get("refresh_interval_seconds") or 15)
        except (TypeError, ValueError):
            return 15

    # ------------------------------------------------------------------
    # Runtime inspection

    def _inspect(self):
        logger.info("Collecting Celery stats via inspect (timeout=%.2fs)", self._inspect_timeout)
        try:
            if EventletTimeout is not None:
                with EventletTimeout(self._inspect_timeout, False):
                    return self._celery.control.inspect(timeout=self._inspect_timeout)
            return self._celery.control.inspect(timeout=self._inspect_timeout)
        except BaseException as exc:  # pragma: no cover - network/broker
            logger.warning("Celery inspect failed: %s", exc)
            return None

    @staticmethod
    def _serialize_args(args: Any) -> list[Any]:
        if isinstance(args, (list, tuple)):
            return list(args)
        if args is None:
            return []
        return [args]

    @staticmethod
    def _serialize_kwargs(kwargs: Any) -> Dict[str, Any]:
        if isinstance(kwargs, Mapping):
            return dict(kwargs)
        return {}

    def _trigger_startup_jobs(self, config: Mapping[str, Any]) -> None:
        jobs = config.get("beat_jobs")
        if not isinstance(jobs, Iterable):
            return
        for entry in jobs:
            if not isinstance(entry, Mapping):
                continue
            if not entry.get("run_on_start"):
                continue
            task_name = str(entry.get("task") or "").strip()
            job_id = str(entry.get("id") or task_name or "").strip()
            if not task_name or not job_id:
                continue
            already_fired = job_id in self._startup_fired
            if not already_fired and self._redis and self._redis.available:
                try:
                    if self._redis.cache_get("celery.startup", job_id):
                        already_fired = True
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning("Startup cache lookup failed for %s: %s", job_id, exc)
            if already_fired:
                logger.info("Startup task %s already fired, skipping", job_id)
                continue
            args = entry.get("args")
            if isinstance(args, (list, tuple)):
                task_args = tuple(args)
            elif args is None:
                task_args = ()
            else:
                task_args = (args,)
            kwargs = entry.get("kwargs") if isinstance(entry.get("kwargs"), Mapping) else {}
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
            try:
                self._celery.send_task(task_name, args=task_args, kwargs=dict(kwargs), **options)
            except Exception as exc:  # pragma: no cover - depends on broker availability
                logger.warning("Failed to trigger startup task %s (%s): %s", job_id, task_name, exc)
                continue
            self._startup_fired.add(job_id)
            if self._redis and self._redis.available:
                try:
                    self._redis.cache_set(
                        "celery.startup",
                        job_id,
                        {"fired_at": datetime.now(timezone.utc).isoformat(), "task": task_name},
                    )
                except Exception as exc:  # pragma: no cover - defensive
                    logger.debug("Failed to record startup task %s in Redis: %s", job_id, exc)
            logger.info("Triggered startup task %s (%s)", job_id, task_name)

    @staticmethod
    def _runtime_from_entry(entry: Mapping[str, Any]) -> Optional[float]:
        runtime = entry.get("runtime")
        if isinstance(runtime, (int, float)):
            return max(0.0, float(runtime))
        time_start = entry.get("time_start")
        if isinstance(time_start, (int, float)) and time_start > 0:
            return max(0.0, time.monotonic() - float(time_start))
        return None

    def _serialize_request(
        self,
        entry: Mapping[str, Any],
        *,
        worker: str,
        category: str,
    ) -> Dict[str, Any]:
        payload = entry.get("request") if category == "scheduled" else entry
        if not isinstance(payload, Mapping):
            payload = {}
        task_id = str(payload.get("id") or payload.get("task_id") or "").strip()
        name = str(payload.get("name") or payload.get("task") or "").strip()
        args = self._serialize_args(payload.get("args"))
        kwargs = self._serialize_kwargs(payload.get("kwargs"))
        eta = entry.get("eta") if category == "scheduled" else payload.get("eta")
        if isinstance(eta, (int, float)):
            eta_dt = datetime.fromtimestamp(float(eta), tz=timezone.utc)
            eta_iso = eta_dt.isoformat()
        elif isinstance(eta, str) and eta:
            eta_iso = eta
        else:
            eta_iso = None
        runtime = self._runtime_from_entry(payload)
        delivery = payload.get("delivery_info")
        queue = None
        if isinstance(delivery, Mapping):
            queue = delivery.get("routing_key") or delivery.get("queue")
        priority = payload.get("priority")
        try:
            priority_value = int(priority) if priority is not None else None
        except (TypeError, ValueError):
            priority_value = None
        return {
            "id": task_id,
            "name": name,
            "args": args,
            "kwargs": kwargs,
            "state": payload.get("state"),
            "received_at": payload.get("time_start") or payload.get("time_received"),
            "eta": eta_iso,
            "runtime": runtime,
            "category": category,
            "worker": worker,
            "queue": queue,
            "priority": priority_value,
        }

    def snapshot(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "active": [],
            "scheduled": [],
            "reserved": [],
            "stats": {},
        }
        inspector = self._inspect()
        if inspector is None:
            info["error"] = "Unable to reach Celery workers."
            return info

        active: Dict[str, Any] = {}
        try:
            if EventletTimeout is not None:
                with EventletTimeout(self._inspect_timeout, False):
                    active = inspector.active() or {}
            else:
                active = inspector.active() or {}
        except Exception as exc:  # pragma: no cover - broker dependent
            logger.warning("Failed to fetch active tasks: %s", exc)
        logger.info("Fetched %d active tasks from Celery", len(active))
        for worker, tasks in active.items():
            if not isinstance(tasks, Iterable):
                continue
            for task in tasks:
                if isinstance(task, Mapping):
                    info["active"].append(self._serialize_request(task, worker=worker, category="active"))

        scheduled: Dict[str, Any] = {}
        try:
            if EventletTimeout is not None:
                with EventletTimeout(self._inspect_timeout, False):
                    scheduled = inspector.scheduled() or {}
            else:
                scheduled = inspector.scheduled() or {}
        except Exception as exc:  # pragma: no cover
            logger.warning("Failed to fetch scheduled tasks: %s", exc)
        logger.info("Fetched scheduled tasks from %d worker(s)", len(scheduled))
        for worker, tasks in scheduled.items():
            if not isinstance(tasks, Iterable):
                continue
            for task in tasks:
                if isinstance(task, Mapping):
                    info["scheduled"].append(self._serialize_request(task, worker=worker, category="scheduled"))

        reserved: Dict[str, Any] = {}
        try:
            if EventletTimeout is not None:
                with EventletTimeout(self._inspect_timeout, False):
                    reserved = inspector.reserved() or {}
            else:
                reserved = inspector.reserved() or {}
        except Exception as exc:  # pragma: no cover
            logger.warning("Failed to fetch reserved tasks: %s", exc)
        logger.info("Fetched reserved tasks from %d worker(s)", len(reserved))
        for worker, tasks in reserved.items():
            if not isinstance(tasks, Iterable):
                continue
            for task in tasks:
                if isinstance(task, Mapping):
                    info["reserved"].append(self._serialize_request(task, worker=worker, category="reserved"))

        stats: Dict[str, Any] = {}
        try:
            if EventletTimeout is not None:
                with EventletTimeout(self._inspect_timeout, False):
                    stats = inspector.stats() or {}
            else:
                stats = inspector.stats() or {}
        except Exception as exc:  # pragma: no cover
            logger.warning("Failed to fetch Celery stats: %s", exc)
        logger.info("Fetched Celery worker stats for %d worker(s)", len(stats))
        if isinstance(stats, Mapping):
            info["stats"] = dict(stats)

        logger.info(
            "Celery snapshot collected: active=%d scheduled=%d reserved=%d workers=%d",
            len(info["active"]),
            len(info["scheduled"]),
            len(info["reserved"]),
            len(info["stats"]),
        )

        return info

    # ------------------------------------------------------------------
    # Runtime controls

    def stop_task(self, task_id: str, *, terminate: bool = False) -> bool:
        if not task_id:
            raise ValueError("task_id is required")
        try:
            self._celery.control.revoke(task_id, terminate=bool(terminate))
        except Exception as exc:  # pragma: no cover - broker dependent
            logger.warning("Failed to revoke task %s: %s", task_id, exc)
            return False
        return True


__all__ = ["TaskMonitorService"]
