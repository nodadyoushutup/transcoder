"""Helpers for persisting system-wide and per-user settings."""
from __future__ import annotations

import logging
import math
import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from sqlalchemy import select, text, update

from ..app.providers import db
from ..models import SystemSetting, User, UserSetting
from .transcoder_schema import (
    TRANSCODER_ALL_KEYS,
    TranscoderSettingsBundle,
    build_default_transcoder_settings,
    sanitize_transcoder_settings,
)


logger = logging.getLogger(__name__)


class SettingsService:
    """High level persistence helpers for settings and user preferences."""

    TRANSCODER_NAMESPACE = "transcoder"
    INGEST_NAMESPACE = "ingest"
    CHAT_NAMESPACE = "chat"
    USERS_NAMESPACE = "users"
    PLAYER_NAMESPACE = "player"
    PLEX_NAMESPACE = "plex"
    LIBRARY_NAMESPACE = "library"
    REDIS_NAMESPACE = "redis"
    TASKS_NAMESPACE = "tasks"
    USER_CHAT_NAMESPACE = "chat"
    USER_APPEARANCE_NAMESPACE = "appearance"

    DEFAULT_CHAT_SETTINGS: Mapping[str, Any] = {
        "notification_sound": "notification_chat.mp3",
        "notification_volume": 0.6,
        "notify_scope": "mentions",
    }

    DEFAULT_USERS_SETTINGS: Mapping[str, Any] = {
        "allow_registration": True,
        "default_group": "user",
    }

    DEFAULT_PLEX_SETTINGS: Mapping[str, Any] = {
        "status": "disconnected",
        "auth_token": None,
        "server_base_url": None,
        "verify_ssl": True,
        "account": None,
        "last_connected_at": None,
        "server": None,
    }

    DEFAULT_LIBRARY_SETTINGS: Mapping[str, Any] = {
        "hidden_sections": [],
        "section_page_size": 500,
        "default_section_view": "library",
        "image_cache_thumb_width": 400,
        "image_cache_thumb_height": 600,
        "image_cache_thumb_quality": 80,
    }

    DEFAULT_PLAYER_SETTINGS: Mapping[str, Any] = {
        "attachMinimumSegments": 3,
        "streaming": {
            "delay": {
                "liveDelay": None,
                "liveDelayFragmentCount": 10,
                "useSuggestedPresentationDelay": True,
            },
            "liveCatchup": {
                "enabled": True,
                "minDrift": 6.0,
                "maxDrift": 10.0,
                "playbackRate": {
                    "min": -0.2,
                    "max": 0.2,
                },
            },
            "buffer": {
                "fastSwitchEnabled": False,
                "bufferPruningInterval": 10,
                "bufferToKeep": 6,
                "bufferTimeAtTopQuality": 8,
                "bufferTimeAtTopQualityLongForm": 10,
            },
            "text": {
                "defaultEnabled": False,
                "defaultLanguage": None,
            },
        },
    }

    _PROJECT_ROOT = Path(__file__).resolve().parents[3]
    _INGEST_RETENTION_ENV = os.getenv("INGEST_RETENTION_SEGMENTS")
    try:
        _INGEST_RETENTION_DEFAULT = int(_INGEST_RETENTION_ENV) if _INGEST_RETENTION_ENV else 36
    except ValueError:
        _INGEST_RETENTION_DEFAULT = 36
    if _INGEST_RETENTION_DEFAULT < 0:
        _INGEST_RETENTION_DEFAULT = 0

    _INGEST_ENABLE_PUT_ENV = os.getenv("INGEST_ENABLE_PUT")
    if _INGEST_ENABLE_PUT_ENV is None:
        _INGEST_ENABLE_PUT_DEFAULT = True
    else:
        _INGEST_ENABLE_PUT_DEFAULT = _INGEST_ENABLE_PUT_ENV.strip().lower() in {"1", "true", "yes", "on"}

    _INGEST_ENABLE_DELETE_ENV = os.getenv("INGEST_ENABLE_DELETE")
    if _INGEST_ENABLE_DELETE_ENV is None:
        _INGEST_ENABLE_DELETE_DEFAULT = True
    else:
        _INGEST_ENABLE_DELETE_DEFAULT = _INGEST_ENABLE_DELETE_ENV.strip().lower() in {"1", "true", "yes", "on"}

    _INGEST_CACHE_MAX_AGE_ENV = os.getenv("INGEST_CACHE_MAX_AGE")
    try:
        _INGEST_CACHE_MAX_AGE_DEFAULT = int(_INGEST_CACHE_MAX_AGE_ENV) if _INGEST_CACHE_MAX_AGE_ENV else 30
    except ValueError:
        _INGEST_CACHE_MAX_AGE_DEFAULT = 30
    if _INGEST_CACHE_MAX_AGE_DEFAULT < 0:
        _INGEST_CACHE_MAX_AGE_DEFAULT = 0

    _INGEST_CACHE_EXTENSIONS_DEFAULT = ["mp4", "m4s", "m4a", "m4v", "vtt", "ts"]

    DEFAULT_INGEST_SETTINGS: Mapping[str, Any] = {
        "OUTPUT_DIR": (
            os.getenv("INGEST_OUTPUT_DIR")
            or os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
            or os.getenv("TRANSCODER_OUTPUT")
            or str(Path.home() / "ingest_data")
        ),
        "RETENTION_SEGMENTS": _INGEST_RETENTION_DEFAULT,
        "TRANSCODER_CORS_ORIGIN": os.getenv("TRANSCODER_CORS_ORIGIN", "*"),
        "INGEST_ENABLE_PUT": _INGEST_ENABLE_PUT_DEFAULT,
        "INGEST_ENABLE_DELETE": _INGEST_ENABLE_DELETE_DEFAULT,
        "INGEST_CACHE_MAX_AGE": _INGEST_CACHE_MAX_AGE_DEFAULT,
        "INGEST_CACHE_EXTENSIONS": list(_INGEST_CACHE_EXTENSIONS_DEFAULT),
    }

    DEFAULT_TASKS_SETTINGS: Mapping[str, Any] = {
        "beat_jobs": [
            {
                "id": "refresh-plex-sections-snapshot",
                "name": "Refresh Plex Sections Snapshot",
                "task": "core.api.src.celery_app.tasks.library.refresh_plex_sections_snapshot",
                "schedule_seconds": 300,
                "enabled": True,
                "queue": "transcoder",
                "args": [],
                "kwargs": {"force_refresh": True},
                "run_on_start": True,
            },
        ],
        "refresh_interval_seconds": 15,
    }

    LIBRARY_SECTION_VIEWS: Tuple[str, ...] = (
        "recommended", "library", "collections")

    DEFAULT_USER_SETTINGS: Mapping[str, Mapping[str, Any]] = {
        USER_CHAT_NAMESPACE: {
            "notification_sound": "notification_chat.mp3",
            "notification_volume": 0.6,
            "notify_scope": "mentions",
        },
        USER_APPEARANCE_NAMESPACE: {
            "theme": "dark",
        },
    }

    @staticmethod
    def _sequence_to_string(values: Sequence[str]) -> str:
        return "\n".join(item for item in values if item) if values else ""

    @staticmethod
    def _normalize_library_hidden_sections(raw: Any) -> list[str]:
        if not isinstance(raw, (list, tuple, set)):
            return []
        normalized: list[str] = []
        seen: set[str] = set()
        for entry in raw:
            if entry is None:
                continue
            identifier = str(entry).strip()
            if not identifier or identifier in seen:
                continue
            normalized.append(identifier)
            seen.add(identifier)
        return normalized

    @staticmethod
    def _normalize_library_page_size(raw: Any, default: Optional[int] = None) -> int:
        fallback = 500
        if isinstance(default, (int, float)):
            fallback = int(default)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = fallback
        return max(1, min(value, 1000))

    @staticmethod
    def _normalize_library_section_view(raw: Any, default: Optional[str] = None) -> str:
        fallback = default or "library"
        if isinstance(raw, str):
            candidate = raw.strip().lower()
            if candidate in SettingsService.LIBRARY_SECTION_VIEWS:
                return candidate
        return fallback if fallback in SettingsService.LIBRARY_SECTION_VIEWS else "library"

    @staticmethod
    def _coerce_corrupted_setting_value(value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, (dict, list, tuple, int, float, bool)):
            return value
        if isinstance(value, (bytes, bytearray)):
            text_value = value.decode("utf-8", errors="replace")
        else:
            text_value = str(value)
        return text_value if text_value.strip() else ""

    @staticmethod
    def _normalize_positive_int(
        raw: Any,
        *,
        fallback: int,
        minimum: int = 0,
        maximum: Optional[int] = None,
    ) -> int:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = fallback
        if maximum is not None and value > maximum:
            value = maximum
        if value < minimum:
            value = minimum
        return value

    @staticmethod
    def _normalize_absolute_path(raw: Any, *, allow_empty: bool = False) -> str:
        """Return an absolute filesystem path string or raise ``ValueError``."""

        if raw is None:
            candidate = ""
        else:
            candidate = str(raw).strip()

        if not candidate:
            if allow_empty:
                return ""
            raise ValueError("Path must not be empty.")

        if os.path.isabs(candidate):
            return candidate

        # Accept Windows drive-letter or UNC absolutes even when running on POSIX.
        if re.match(r"^[A-Za-z]:[\\/].*", candidate):
            return candidate
        if candidate.startswith("\\\\"):
            return candidate

        raise ValueError("Path must be absolute (e.g. /mnt/storage or C:\\media\\out).")

    @staticmethod
    def _coerce_bool(raw: Any, fallback: bool) -> bool:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str):
            candidate = raw.strip().lower()
            if candidate in {"true", "1", "yes", "on"}:
                return True
            if candidate in {"false", "0", "no", "off"}:
                return False
        if isinstance(raw, (int, float)):
            return bool(raw)
        return fallback

    @staticmethod
    def _normalize_optional_float(
        raw: Any,
        *,
        fallback: Optional[float],
        minimum: Optional[float] = None,
        maximum: Optional[float] = None,
        allow_none: bool = False,
    ) -> Optional[float]:
        if raw is None:
            return None if allow_none else fallback
        if isinstance(raw, str) and not raw.strip():
            return None if allow_none else fallback
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return fallback
        if not math.isfinite(value):
            return None if allow_none else fallback
        if minimum is not None and value < minimum:
            value = minimum
        if maximum is not None and value > maximum:
            value = maximum
        return value

    @staticmethod
    def _redis_env_settings() -> Dict[str, Any]:
        redis_url = (
            os.getenv("TRANSCODER_REDIS_URL")
            or os.getenv("REDIS_URL")
            or os.getenv("CELERY_BROKER_URL")
            or ""
        )
        raw_max_entries = os.getenv("TRANSCODER_REDIS_MAX_ENTRIES")
        raw_ttl = os.getenv("TRANSCODER_REDIS_TTL_SECONDS")

        def _coerce_positive_int(raw_value: Any, fallback: int, maximum: int) -> int:
            try:
                candidate = int(raw_value)
            except (TypeError, ValueError):
                candidate = fallback
            if candidate < 0:
                candidate = 0
            if maximum is not None and candidate > maximum:
                candidate = maximum
            return candidate

        max_entries = _coerce_positive_int(raw_max_entries, 0, 50000)
        ttl_seconds = _coerce_positive_int(raw_ttl, 0, 86400 * 7)

        return {
            "redis_url": str(redis_url or "").strip(),
            "max_entries": max_entries,
            "ttl_seconds": ttl_seconds,
        }

    def sanitize_redis_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = self._redis_env_settings()
        merged: Dict[str, Any] = dict(defaults)
        if overrides:
            for key, value in overrides.items():
                merged[key] = value

        redis_url = str(merged.get("redis_url") or "").strip()
        max_entries = self._normalize_positive_int(
            merged.get("max_entries"),
            fallback=int(defaults.get("max_entries", 0) or 0),
            minimum=0,
            maximum=50000,
        )
        ttl_seconds = self._normalize_positive_int(
            merged.get("ttl_seconds"),
            fallback=int(defaults.get("ttl_seconds", 0) or 0),
            minimum=0,
            maximum=86400 * 7,
        )

        backend = "redis" if redis_url else "disabled"

        return {
            "redis_url": redis_url,
            "max_entries": max_entries,
            "ttl_seconds": ttl_seconds,
            "backend": backend,
        }

    def get_sanitized_redis_settings(self) -> Dict[str, Any]:
        return self.sanitize_redis_settings()

    def sanitize_ingest_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = dict(self.DEFAULT_INGEST_SETTINGS)
        override_map: Mapping[str, Any] = overrides if isinstance(overrides, Mapping) else {}

        output_dir = str(defaults.get("OUTPUT_DIR") or "").strip()
        final_path = self._normalize_absolute_path(output_dir)
        if "OUTPUT_DIR" in override_map:
            candidate = override_map.get("OUTPUT_DIR")
            final_path = self._normalize_absolute_path(candidate)

        retention_default = self._normalize_positive_int(
            defaults.get("RETENTION_SEGMENTS"),
            fallback=self._INGEST_RETENTION_DEFAULT,
            minimum=0,
        )
        retention_value = retention_default
        if "RETENTION_SEGMENTS" in override_map:
            retention_value = self._normalize_positive_int(
                override_map.get("RETENTION_SEGMENTS"),
                fallback=retention_default,
                minimum=0,
            )

        cors_default = str(defaults.get("TRANSCODER_CORS_ORIGIN") or "").strip() or "*"
        cors_value = cors_default
        if "TRANSCODER_CORS_ORIGIN" in override_map:
            candidate = str(override_map.get("TRANSCODER_CORS_ORIGIN") or "").strip()
            cors_value = candidate or cors_default

        enable_put_default = bool(defaults.get("INGEST_ENABLE_PUT", True))
        enable_put_value = self._coerce_bool(
            override_map.get("INGEST_ENABLE_PUT"),
            enable_put_default,
        )

        enable_delete_default = bool(defaults.get("INGEST_ENABLE_DELETE", True))
        enable_delete_value = self._coerce_bool(
            override_map.get("INGEST_ENABLE_DELETE"),
            enable_delete_default,
        )

        cache_max_age_default = self._normalize_positive_int(
            defaults.get("INGEST_CACHE_MAX_AGE"),
            fallback=self._INGEST_CACHE_MAX_AGE_DEFAULT,
            minimum=0,
        )
        cache_max_age_value = cache_max_age_default
        if "INGEST_CACHE_MAX_AGE" in override_map:
            cache_max_age_value = self._normalize_positive_int(
                override_map.get("INGEST_CACHE_MAX_AGE"),
                fallback=cache_max_age_default,
                minimum=0,
            )

        def _normalize_extensions(raw: Any) -> list[str]:
            if isinstance(raw, (list, tuple, set)):
                iterable = raw
            elif isinstance(raw, str):
                iterable = [piece.strip() for piece in raw.replace("\n", ",").split(",")]
            else:
                return list(self._INGEST_CACHE_EXTENSIONS_DEFAULT)
            normalized: list[str] = []
            for entry in iterable:
                if not entry:
                    continue
                normalized.append(str(entry).strip().lower())
            return normalized or list(self._INGEST_CACHE_EXTENSIONS_DEFAULT)

        cache_extensions_value = _normalize_extensions(defaults.get("INGEST_CACHE_EXTENSIONS"))
        if "INGEST_CACHE_EXTENSIONS" in override_map:
            cache_extensions_value = _normalize_extensions(override_map.get("INGEST_CACHE_EXTENSIONS"))

        return {
            "OUTPUT_DIR": final_path,
            "RETENTION_SEGMENTS": retention_value,
            "TRANSCODER_CORS_ORIGIN": cors_value,
            "INGEST_ENABLE_PUT": enable_put_value,
            "INGEST_ENABLE_DELETE": enable_delete_value,
            "INGEST_CACHE_MAX_AGE": cache_max_age_value,
            "INGEST_CACHE_EXTENSIONS": cache_extensions_value,
        }

    def get_sanitized_ingest_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.INGEST_NAMESPACE)
        return self.sanitize_ingest_settings(raw)

    def sanitize_player_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = deepcopy(self.DEFAULT_PLAYER_SETTINGS)
        streaming_defaults: Dict[str, Any] = defaults.get("streaming", {})
        streaming_overrides = overrides.get("streaming") if isinstance(overrides, Mapping) else None

        if isinstance(streaming_overrides, Mapping):
            delay_defaults: Dict[str, Any] = streaming_defaults.get("delay", {})
            delay_overrides = streaming_overrides.get("delay")
            if isinstance(delay_overrides, Mapping):
                delay_defaults["liveDelay"] = self._normalize_optional_float(
                    delay_overrides.get("liveDelay"),
                    fallback=None,
                    minimum=0.0,
                    allow_none=True,
                )
                delay_defaults["liveDelayFragmentCount"] = self._normalize_positive_int(
                    delay_overrides.get("liveDelayFragmentCount"),
                    fallback=int(delay_defaults.get("liveDelayFragmentCount", 10) or 10),
                    minimum=0,
                    maximum=240,
                )
                delay_defaults["useSuggestedPresentationDelay"] = self._coerce_bool(
                    delay_overrides.get("useSuggestedPresentationDelay"),
                    bool(delay_defaults.get("useSuggestedPresentationDelay", True)),
                )

            catchup_defaults: Dict[str, Any] = streaming_defaults.get("liveCatchup", {})
            catchup_overrides = streaming_overrides.get("liveCatchup")
            if isinstance(catchup_overrides, Mapping):
                catchup_defaults["enabled"] = self._coerce_bool(
                    catchup_overrides.get("enabled"),
                    bool(catchup_defaults.get("enabled", True)),
                )
                catchup_defaults["minDrift"] = self._normalize_optional_float(
                    catchup_overrides.get("minDrift"),
                    fallback=float(catchup_defaults.get("minDrift", 2.0) or 0.0),
                    minimum=0.0,
                    maximum=120.0,
                )
                catchup_defaults["maxDrift"] = self._normalize_optional_float(
                    catchup_overrides.get("maxDrift"),
                    fallback=float(catchup_defaults.get("maxDrift", 1.0) or 1.0),
                    minimum=0.0,
                    maximum=30.0,
                )
                if (
                    catchup_defaults.get("minDrift") is not None
                    and catchup_defaults.get("maxDrift") is not None
                    and catchup_defaults["minDrift"] > catchup_defaults["maxDrift"]
                ):
                    catchup_defaults["maxDrift"] = catchup_defaults["minDrift"]
                playback_defaults = catchup_defaults.get("playbackRate", {})
                playback_overrides = catchup_overrides.get("playbackRate")
                if isinstance(playback_overrides, Mapping):
                    min_default = float(playback_defaults.get("min", -0.2) or -0.2)
                    max_default = float(playback_defaults.get("max", 0.2) or 0.2)
                    rate_min = self._normalize_optional_float(
                        playback_overrides.get("min"),
                        fallback=min_default,
                        minimum=-1.0,
                        maximum=1.0,
                    )
                    rate_max = self._normalize_optional_float(
                        playback_overrides.get("max"),
                        fallback=max_default,
                        minimum=-1.0,
                        maximum=1.0,
                    )
                    if rate_min is not None and rate_max is not None and rate_min > rate_max:
                        rate_min, rate_max = rate_max, rate_min
                    playback_defaults["min"] = rate_min if rate_min is not None else min_default
                    playback_defaults["max"] = rate_max if rate_max is not None else max_default
                    catchup_defaults["playbackRate"] = playback_defaults

            buffer_defaults: Dict[str, Any] = streaming_defaults.get("buffer", {})
            buffer_overrides = streaming_overrides.get("buffer")
            if isinstance(buffer_overrides, Mapping):
                buffer_defaults["fastSwitchEnabled"] = self._coerce_bool(
                    buffer_overrides.get("fastSwitchEnabled"),
                    bool(buffer_defaults.get("fastSwitchEnabled", False)),
                )
                for key in (
                    "bufferPruningInterval",
                    "bufferToKeep",
                    "bufferTimeAtTopQuality",
                    "bufferTimeAtTopQualityLongForm",
                ):
                    fallback_value = int(buffer_defaults.get(key, 10) or 0)
                    buffer_defaults[key] = self._normalize_positive_int(
                        buffer_overrides.get(key),
                        fallback=fallback_value,
                        minimum=0,
                        maximum=86400,
                    )

            text_defaults: Dict[str, Any] = streaming_defaults.get("text", {})
            if (
                "preferredLanguage" in text_defaults
                and "defaultLanguage" not in text_defaults
            ):
                text_defaults["defaultLanguage"] = text_defaults.pop("preferredLanguage")
            text_overrides = streaming_overrides.get("text")
            if isinstance(text_overrides, Mapping):
                text_defaults["defaultEnabled"] = self._coerce_bool(
                    text_overrides.get("defaultEnabled"),
                    bool(text_defaults.get("defaultEnabled", False)),
                )
                preferred_raw = None
                if "defaultLanguage" in text_overrides:
                    preferred_raw = text_overrides.get("defaultLanguage")
                elif "preferredLanguage" in text_overrides:
                    preferred_raw = text_overrides.get("preferredLanguage")

                if preferred_raw is None:
                    text_defaults["defaultLanguage"] = None
                elif isinstance(preferred_raw, str):
                    trimmed = preferred_raw.strip()
                    text_defaults["defaultLanguage"] = trimmed or None
                else:
                    text_defaults["defaultLanguage"] = str(preferred_raw).strip() or None

                text_defaults.pop("preferredLanguage", None)

            elif "preferredLanguage" in text_defaults:
                # Ensure persisted defaults drop the legacy key even if no overrides provided.
                text_defaults["defaultLanguage"] = text_defaults.pop("preferredLanguage")

        attach_fallback = int(defaults.get("attachMinimumSegments", 0) or 0)
        attach_source = (
            overrides.get("attachMinimumSegments")
            if isinstance(overrides, Mapping) and "attachMinimumSegments" in overrides
            else defaults.get("attachMinimumSegments")
        )
        defaults["attachMinimumSegments"] = self._normalize_positive_int(
            attach_source,
            fallback=attach_fallback,
            minimum=0,
            maximum=240,
        )

        if isinstance(overrides, Mapping):
            for key, value in overrides.items():
                if key in defaults:
                    continue
                defaults[key] = deepcopy(value) if isinstance(value, (dict, list)) else value

        return defaults

    def get_sanitized_player_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.PLAYER_NAMESPACE)
        return self.sanitize_player_settings(raw)

    def sanitize_tasks_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = self.DEFAULT_TASKS_SETTINGS
        merged_jobs: list[dict[str, Any]] = []
        default_jobs = defaults.get("beat_jobs", [])
        default_run_map: dict[str, bool] = {}
        for default_job in default_jobs:
            if not isinstance(default_job, Mapping):
                continue
            default_id = str(default_job.get(
                "id") or default_job.get("task") or "").strip()
            if default_id:
                default_run_map[default_id] = bool(
                    default_job.get("run_on_start", False))
        try:
            default_schedule_seconds = int(
                default_jobs[0].get("schedule_seconds") or 300)
        except (IndexError, AttributeError, TypeError, ValueError):
            default_schedule_seconds = 300
        raw_jobs = None
        if overrides and isinstance(overrides.get("beat_jobs"), list):
            raw_jobs = overrides.get("beat_jobs")
        elif overrides and isinstance(overrides.get("beat_jobs"), tuple):
            raw_jobs = list(overrides.get("beat_jobs"))
        else:
            raw_jobs = defaults.get("beat_jobs", [])

        seen_ids: set[str] = set()
        for entry in raw_jobs or []:
            if not isinstance(entry, Mapping):
                continue
            job_id = str(entry.get("id") or entry.get("name")
                         or entry.get("task") or "").strip()
            if not job_id:
                continue
            if job_id in seen_ids:
                continue
            seen_ids.add(job_id)
            name = str(entry.get("name") or job_id).strip()
            task_name = str(entry.get("task") or "").strip()
            if not task_name:
                continue
            try:
                schedule_seconds = int(entry.get("schedule_seconds") or 0)
            except (TypeError, ValueError):
                schedule_seconds = 0
            schedule_seconds = max(
                1, min(schedule_seconds, 86400 * 30)) if schedule_seconds else 0
            args_raw = entry.get("args")
            if isinstance(args_raw, (list, tuple)):
                args = [item for item in args_raw]
            elif args_raw is None:
                args = []
            else:
                args = [args_raw]
            kwargs_raw = entry.get("kwargs")
            kwargs = kwargs_raw if isinstance(kwargs_raw, Mapping) else {}
            queue = entry.get("queue")
            queue_name = str(queue).strip() if isinstance(queue, str) else None
            priority = entry.get("priority")
            try:
                priority_value = int(
                    priority) if priority is not None else None
            except (TypeError, ValueError):
                priority_value = None
            merged_jobs.append(
                {
                    "id": job_id,
                    "name": name or job_id,
                    "task": task_name,
                    "schedule_seconds": schedule_seconds or default_schedule_seconds,
                    "enabled": bool(entry.get("enabled", True)),
                    "queue": queue_name or None,
                    "priority": priority_value,
                    "args": args,
                    "kwargs": dict(kwargs),
                    "run_on_start": bool(entry.get("run_on_start", default_run_map.get(job_id, False))),
                }
            )

        if not merged_jobs and default_jobs:
            fallback_job = default_jobs[0]
            if isinstance(fallback_job, Mapping):
                merged_jobs = [
                    {
                        "id": str(fallback_job.get("id") or fallback_job.get("task") or "").strip() or "startup",
                        "name": str(fallback_job.get("name") or fallback_job.get("task") or "Startup task"),
                        "task": str(fallback_job.get("task") or ""),
                        "schedule_seconds": default_schedule_seconds,
                        "enabled": bool(fallback_job.get("enabled", True)),
                        "queue": str(fallback_job.get("queue") or "").strip() or None,
                        "priority": None,
                        "args": list(fallback_job.get("args") or []),
                        "kwargs": dict(fallback_job.get("kwargs") or {}),
                        "run_on_start": bool(fallback_job.get("run_on_start", False)),
                    }
                ]
            else:
                merged_jobs = []

        refresh_raw = overrides.get("refresh_interval_seconds") if isinstance(
            overrides, Mapping) else None
        try:
            refresh_interval = int(refresh_raw)
        except (TypeError, ValueError):
            refresh_interval = int(defaults.get(
                "refresh_interval_seconds", 15) or 15)
        refresh_interval = max(5, min(refresh_interval, 300))

        return {
            "beat_jobs": merged_jobs,
            "refresh_interval_seconds": refresh_interval,
        }

    def get_sanitized_tasks_settings(self) -> Dict[str, Any]:
        settings = self.get_system_settings(self.TASKS_NAMESPACE)
        if "beat_jobs" not in settings:
            defaults = {
                "beat_jobs": self.DEFAULT_TASKS_SETTINGS.get("beat_jobs", []),
                "refresh_interval_seconds": self.DEFAULT_TASKS_SETTINGS.get("refresh_interval_seconds", 15),
            }
            self._ensure_namespace_defaults(self.TASKS_NAMESPACE, defaults)
            settings = self.get_system_settings(self.TASKS_NAMESPACE)
        return self.sanitize_tasks_settings(settings)

    def set_tasks_settings(
        self,
        values: Mapping[str, Any],
        *,
        updated_by: Optional[User] = None,
    ) -> Dict[str, Any]:
        sanitized = self.sanitize_tasks_settings(values)
        beat_jobs = sanitized.get("beat_jobs", [])
        refresh_interval = sanitized.get("refresh_interval_seconds")
        self.set_system_setting(
            self.TASKS_NAMESPACE,
            "beat_jobs",
            beat_jobs,
            updated_by=updated_by,
        )
        self.set_system_setting(
            self.TASKS_NAMESPACE,
            "refresh_interval_seconds",
            refresh_interval,
            updated_by=updated_by,
        )
        return sanitized

    def sanitize_library_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = self.system_defaults(self.LIBRARY_NAMESPACE)
        hidden = self._normalize_library_hidden_sections(
            defaults.get("hidden_sections", []))
        page_size = self._normalize_library_page_size(defaults.get(
            "section_page_size"), defaults.get("section_page_size"))
        section_view = self._normalize_library_section_view(
            defaults.get("default_section_view"), "library")

        thumb_width = self._normalize_positive_int(
            defaults.get("image_cache_thumb_width"),
            fallback=320,
            minimum=64,
            maximum=1920,
        )
        thumb_height = self._normalize_positive_int(
            defaults.get("image_cache_thumb_height"),
            fallback=480,
            minimum=64,
            maximum=1920,
        )
        thumb_quality = self._normalize_positive_int(
            defaults.get("image_cache_thumb_quality"),
            fallback=80,
            minimum=10,
            maximum=100,
        )

        if overrides:
            if "hidden_sections" in overrides:
                hidden = self._normalize_library_hidden_sections(
                    overrides.get("hidden_sections"))
            if "section_page_size" in overrides:
                page_size = self._normalize_library_page_size(overrides.get(
                    "section_page_size"), defaults.get("section_page_size"))
            if "default_section_view" in overrides:
                section_view = self._normalize_library_section_view(
                    overrides.get("default_section_view"),
                    section_view,
                )
            if "image_cache_thumb_width" in overrides:
                thumb_width = self._normalize_positive_int(
                    overrides.get("image_cache_thumb_width"),
                    fallback=thumb_width,
                    minimum=64,
                    maximum=1920,
                )
            if "image_cache_thumb_height" in overrides:
                thumb_height = self._normalize_positive_int(
                    overrides.get("image_cache_thumb_height"),
                    fallback=thumb_height,
                    minimum=64,
                    maximum=1920,
                )
            if "image_cache_thumb_quality" in overrides:
                thumb_quality = self._normalize_positive_int(
                    overrides.get("image_cache_thumb_quality"),
                    fallback=thumb_quality,
                    minimum=10,
                    maximum=100,
                )

        return {
            "hidden_sections": hidden,
            "section_page_size": page_size,
            "default_section_view": section_view,
            "image_cache_thumb_width": thumb_width,
            "image_cache_thumb_height": thumb_height,
            "image_cache_thumb_quality": thumb_quality,
        }

    def get_sanitized_library_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.LIBRARY_NAMESPACE)
        return self.sanitize_library_settings(raw)

    def _transcoder_defaults(self) -> Dict[str, Any]:
        publish_base_env = (os.getenv("TRANSCODER_PUBLISH_BASE_URL") or "http://localhost:5005/media/").strip()

        output_dir_default = (
            os.getenv("TRANSCODER_OUTPUT")
            or os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
            or str(Path.home() / "transcode_data")
        )

        defaults = build_default_transcoder_settings(
            publish_base_url=publish_base_env,
            output_dir=output_dir_default,
        )
        defaults.setdefault("TRANSCODER_AUTO_KEYFRAMING", True)
        return defaults

    def ensure_defaults(self) -> None:
        """Seed the system with baseline settings if empty."""

        self._ensure_namespace_defaults(
            self.TRANSCODER_NAMESPACE, self._transcoder_defaults())
        self._ensure_namespace_defaults(
            self.CHAT_NAMESPACE, dict(self.DEFAULT_CHAT_SETTINGS))
        self._ensure_namespace_defaults(
            self.USERS_NAMESPACE, dict(self.DEFAULT_USERS_SETTINGS))
        self._ensure_namespace_defaults(
            self.PLEX_NAMESPACE, dict(self.DEFAULT_PLEX_SETTINGS))
        library_defaults = dict(self.DEFAULT_LIBRARY_SETTINGS)
        if not isinstance(library_defaults.get("hidden_sections"), list):
            library_defaults["hidden_sections"] = []
        else:
            library_defaults["hidden_sections"] = list(
                library_defaults["hidden_sections"])
        default_view = library_defaults.get("default_section_view")
        library_defaults["default_section_view"] = self._normalize_library_section_view(
            default_view, "library")
        self._ensure_namespace_defaults(
            self.LIBRARY_NAMESPACE, library_defaults)
        player_defaults = deepcopy(self.DEFAULT_PLAYER_SETTINGS)
        self._ensure_namespace_defaults(self.PLAYER_NAMESPACE, player_defaults)
        ingest_defaults = dict(self.DEFAULT_INGEST_SETTINGS)
        self._ensure_namespace_defaults(self.INGEST_NAMESPACE, ingest_defaults)

    def _ensure_namespace_defaults(self, namespace: str, defaults: Mapping[str, Any]) -> None:
        existing = {
            setting.key: setting
            for setting in SystemSetting.query.filter_by(namespace=namespace).all()
        }
        changed = False
        for key, value in defaults.items():
            if key in existing:
                continue
            db.session.add(SystemSetting(
                namespace=namespace, key=key, value=value))
            changed = True
        if changed:
            db.session.commit()

    def get_system_settings(self, namespace: str) -> Dict[str, Any]:
        self._repair_invalid_json_values(namespace)
        try:
            db.session.expire_all()
        except Exception:  # pragma: no cover - defensive
            logger.debug("Failed to expire cached settings for namespace %s", namespace, exc_info=True)
        stmt = select(SystemSetting).filter(
            SystemSetting.namespace == namespace)
        records = db.session.execute(stmt).scalars()
        data = {setting.key: setting.value for setting in records}
        return data

    def get_transcoder_settings_bundle(self) -> TranscoderSettingsBundle:
        defaults = self._transcoder_defaults()
        current = self.get_system_settings(self.TRANSCODER_NAMESPACE)
        return sanitize_transcoder_settings(current, defaults=defaults)

    def sanitize_transcoder_values(self, values: Mapping[str, Any]) -> TranscoderSettingsBundle:
        defaults = self._transcoder_defaults()
        return sanitize_transcoder_settings(values, defaults=defaults)

    def _repair_invalid_json_values(self, namespace: str) -> None:
        invalid_stmt = text(
            "SELECT id, key, value FROM system_settings "
            "WHERE namespace = :namespace AND json_valid(value) = 0"
        )
        rows = list(db.session.execute(invalid_stmt, {"namespace": namespace}))
        if not rows:
            return
        dirty = False
        for row in rows:
            mapping = row._mapping
            raw_value = mapping.get("value")
            sanitized_value = self._coerce_corrupted_setting_value(raw_value)
            update_stmt = (
                update(SystemSetting)
                .where(SystemSetting.id == mapping.get("id"))
                .values(value=sanitized_value)
            )
            db.session.execute(update_stmt)
            dirty = True
            logger.warning(
                "Sanitized invalid JSON for system setting %s/%s",
                namespace,
                mapping.get("key"),
            )
        if dirty:
            db.session.commit()

    def system_defaults(self, namespace: str) -> Dict[str, Any]:
        if namespace == self.TRANSCODER_NAMESPACE:
            defaults = self._transcoder_defaults()
            bundle = sanitize_transcoder_settings(defaults, defaults=defaults)
            return dict(bundle.stored)
        if namespace == self.CHAT_NAMESPACE:
            return dict(self.DEFAULT_CHAT_SETTINGS)
        if namespace == self.USERS_NAMESPACE:
            return dict(self.DEFAULT_USERS_SETTINGS)
        if namespace == self.PLEX_NAMESPACE:
            return dict(self.DEFAULT_PLEX_SETTINGS)
        if namespace == self.LIBRARY_NAMESPACE:
            hidden = self.DEFAULT_LIBRARY_SETTINGS.get("hidden_sections", [])
            section_page_size = self.DEFAULT_LIBRARY_SETTINGS.get(
                "section_page_size")
            default_view = self.DEFAULT_LIBRARY_SETTINGS.get(
                "default_section_view")
            normalized_hidden = list(hidden) if isinstance(
                hidden, (list, tuple, set)) else []
            return {
                "hidden_sections": normalized_hidden,
                "section_page_size": section_page_size,
                "default_section_view": self._normalize_library_section_view(default_view, "library"),
            }
        if namespace == self.REDIS_NAMESPACE:
            defaults = self.sanitize_redis_settings()
            return {
                "redis_url": defaults.get("redis_url", ""),
                "max_entries": defaults.get("max_entries", 0),
                "ttl_seconds": defaults.get("ttl_seconds", 0),
                "backend": defaults.get("backend", "disabled"),
            }
        if namespace == self.PLAYER_NAMESPACE:
            return self.sanitize_player_settings(self.DEFAULT_PLAYER_SETTINGS)
        if namespace == self.INGEST_NAMESPACE:
            return dict(self.DEFAULT_INGEST_SETTINGS)
        if namespace == self.TASKS_NAMESPACE:
            return self.sanitize_tasks_settings(self.DEFAULT_TASKS_SETTINGS)
        return {}

    def set_system_setting(
        self,
        namespace: str,
        key: str,
        value: Any,
        *,
        updated_by: Optional[User] = None,
    ) -> SystemSetting:
        record = SystemSetting.query.filter_by(
            namespace=namespace, key=key).first()
        if not record:
            record = SystemSetting(namespace=namespace, key=key)
        record.value = value
        record.updated_by = updated_by
        db.session.add(record)
        db.session.commit()
        return record

    def delete_system_setting(self, namespace: str, key: str) -> None:
        record = SystemSetting.query.filter_by(namespace=namespace, key=key).first()
        if not record:
            return
        db.session.delete(record)
        db.session.commit()

    def ensure_user_defaults(self, user: User) -> None:
        """Create baseline preference rows for a user when they are first seen."""

        defaults = self.DEFAULT_USER_SETTINGS
        for namespace, values in defaults.items():
            for key, value in values.items():
                existing = UserSetting.query.filter_by(
                    user_id=user.id,
                    namespace=namespace,
                    key=key,
                ).first()
                if existing:
                    continue
                db.session.add(UserSetting(user_id=user.id,
                               namespace=namespace, key=key, value=value))
        db.session.commit()

    def get_user_settings(self, user: User, namespace: str) -> Dict[str, Any]:
        stmt = (
            select(UserSetting)
            .filter(UserSetting.user_id == user.id)
            .filter(UserSetting.namespace == namespace)
        )
        records = db.session.execute(stmt).scalars()
        return {setting.key: setting.value for setting in records}

    def user_defaults(self, namespace: str) -> Dict[str, Any]:
        values = self.DEFAULT_USER_SETTINGS.get(namespace, {})
        return dict(values)

    def set_user_setting(self, user: User, namespace: str, key: str, value: Any) -> UserSetting:
        record = UserSetting.query.filter_by(
            user_id=user.id, namespace=namespace, key=key).first()
        if not record:
            record = UserSetting(user_id=user.id, namespace=namespace, key=key)
        record.value = value
        db.session.add(record)
        db.session.commit()
        return record


__all__ = ["SettingsService"]
