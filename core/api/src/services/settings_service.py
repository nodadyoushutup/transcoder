"""Helpers for persisting system-wide and per-user settings."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from sqlalchemy import select

from ..extensions import db
from ..models import SystemSetting, User, UserSetting
from ..transcoder.config import AudioEncodingOptions, VideoEncodingOptions


class SettingsService:
    """High level persistence helpers for settings and user preferences."""

    TRANSCODER_NAMESPACE = "transcoder"
    INGEST_NAMESPACE = "ingest"
    CHAT_NAMESPACE = "chat"
    USERS_NAMESPACE = "users"
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
        "image_cache_thumb_width": 320,
        "image_cache_thumb_height": 480,
        "image_cache_thumb_quality": 80,
    }

    DEFAULT_REDIS_SETTINGS: Mapping[str, Any] = {
        "redis_url": "",
        "max_entries": 0,
        "ttl_seconds": 0,
    }

    _PROJECT_ROOT = Path(__file__).resolve().parents[3]
    DEFAULT_INGEST_SETTINGS: Mapping[str, Any] = {
        "OUTPUT_DIR": (
            os.getenv("INGEST_OUTPUT_DIR")
            or os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
            or os.getenv("TRANSCODER_OUTPUT")
            or str(_PROJECT_ROOT / "ingest" / "out")
        ),
    }

    DEFAULT_TASKS_SETTINGS: Mapping[str, Any] = {
        "beat_jobs": [
            {
                "id": "refresh-plex-sections-snapshot",
                "name": "Refresh Plex Sections Snapshot",
                "task": "core.api.src.tasks.library.refresh_plex_sections_snapshot",
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

    def sanitize_redis_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = dict(self.DEFAULT_REDIS_SETTINGS)
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

        backend = "redis" if redis_url else "memory"

        return {
            "redis_url": redis_url,
            "max_entries": max_entries,
            "ttl_seconds": ttl_seconds,
            "backend": backend,
        }

    def get_sanitized_redis_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.REDIS_NAMESPACE)
        return self.sanitize_redis_settings(raw)

    def sanitize_ingest_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = dict(self.DEFAULT_INGEST_SETTINGS)
        output_dir = str(defaults.get("OUTPUT_DIR") or "").strip()
        final_path = self._normalize_absolute_path(output_dir)
        if overrides and "OUTPUT_DIR" in overrides:
            candidate = overrides.get("OUTPUT_DIR")
            final_path = self._normalize_absolute_path(candidate)

        return {"OUTPUT_DIR": final_path}

    def get_sanitized_ingest_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.INGEST_NAMESPACE)
        return self.sanitize_ingest_settings(raw)

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
        video_defaults = VideoEncodingOptions()
        audio_defaults = AudioEncodingOptions()

        video_filters = tuple(video_defaults.filters)
        if video_filters == ("scale=3840:-2",):
            scale_preset = "4k"
        elif video_filters == ("scale=1920:-2",):
            scale_preset = "1080p"
        elif video_filters == ("scale=1280:-2",):
            scale_preset = "720p"
        elif not video_filters:
            scale_preset = "source"
        else:
            scale_preset = "custom"

        frame_rate = video_defaults.frame_rate
        if isinstance(frame_rate, str) and frame_rate.strip():
            fps_default = frame_rate.strip()
        elif frame_rate is not None:
            fps_default = str(frame_rate)
        else:
            fps_default = "source"

        force_new_conn_env = os.getenv("TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION")
        if force_new_conn_env is None:
            force_new_conn_default = False
        else:
            force_new_conn_default = force_new_conn_env.strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }

        publish_base_env = os.getenv("TRANSCODER_PUBLISH_BASE_URL")
        if not publish_base_env:
            publish_base_env = os.getenv("TRANSCODER_LOCAL_MEDIA_BASE_URL")
        publish_base_env = (publish_base_env or "http://localhost:5005/media/").strip()

        return {
            "TRANSCODER_PUBLISH_BASE_URL": publish_base_env,
            "TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION": force_new_conn_default,
            "TRANSCODER_LOCAL_OUTPUT_DIR": (
                os.getenv("TRANSCODER_OUTPUT")
                or os.getenv("TRANSCODER_SHARED_OUTPUT_DIR")
                or str(self._PROJECT_ROOT / "ingest" / "out")
            ),
            "VIDEO_CODEC": video_defaults.codec,
            "VIDEO_BITRATE": video_defaults.bitrate,
            "VIDEO_MAXRATE": video_defaults.maxrate,
            "VIDEO_BUFSIZE": video_defaults.bufsize,
            "VIDEO_PRESET": video_defaults.preset,
            "VIDEO_PROFILE": video_defaults.profile,
            "VIDEO_TUNE": video_defaults.tune,
            "VIDEO_GOP_SIZE": video_defaults.gop_size,
            "VIDEO_KEYINT_MIN": video_defaults.keyint_min,
            "VIDEO_SC_THRESHOLD": video_defaults.sc_threshold,
            "VIDEO_VSYNC": video_defaults.vsync,
            "VIDEO_FPS": fps_default,
            "VIDEO_FILTERS": self._sequence_to_string(video_filters),
            "VIDEO_EXTRA_ARGS": self._sequence_to_string(tuple(video_defaults.extra_args)),
            "VIDEO_SCALE": scale_preset,
            "AUDIO_CODEC": audio_defaults.codec,
            "AUDIO_BITRATE": audio_defaults.bitrate,
            "AUDIO_CHANNELS": audio_defaults.channels,
            "AUDIO_SAMPLE_RATE": audio_defaults.sample_rate,
            "AUDIO_PROFILE": audio_defaults.profile,
            "AUDIO_FILTERS": self._sequence_to_string(tuple(audio_defaults.filters)),
            "AUDIO_EXTRA_ARGS": self._sequence_to_string(tuple(audio_defaults.extra_args)),
        }

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
        redis_defaults = dict(self.DEFAULT_REDIS_SETTINGS)
        self._ensure_namespace_defaults(self.REDIS_NAMESPACE, redis_defaults)
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
        stmt = select(SystemSetting).filter(
            SystemSetting.namespace == namespace)
        records = db.session.execute(stmt).scalars()
        return {setting.key: setting.value for setting in records}

    def system_defaults(self, namespace: str) -> Dict[str, Any]:
        if namespace == self.TRANSCODER_NAMESPACE:
            return self._transcoder_defaults()
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
            defaults = self.sanitize_redis_settings(
                self.DEFAULT_REDIS_SETTINGS)
            return {
                "redis_url": defaults.get("redis_url", ""),
                "max_entries": defaults.get("max_entries", 0),
                "ttl_seconds": defaults.get("ttl_seconds", 0),
            }
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
