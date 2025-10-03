"""Helpers for persisting system-wide and per-user settings."""
from __future__ import annotations

import os
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from sqlalchemy import select

from ..extensions import db
from ..models import SystemSetting, User, UserSetting
from ..transcoder.config import AudioEncodingOptions, VideoEncodingOptions


class SettingsService:
    """High level persistence helpers for settings and user preferences."""

    TRANSCODER_NAMESPACE = "transcoder"
    CHAT_NAMESPACE = "chat"
    USERS_NAMESPACE = "users"
    PLEX_NAMESPACE = "plex"
    LIBRARY_NAMESPACE = "library"
    CACHE_NAMESPACE = "cache"
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
    }

    DEFAULT_CACHE_SETTINGS: Mapping[str, Any] = {
        "redis_url": "",
        "max_entries": 512,
        "ttl_seconds": 900,
    }

    LIBRARY_SECTION_VIEWS: Tuple[str, ...] = ("recommended", "library", "collections")

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

    def sanitize_cache_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = dict(self.DEFAULT_CACHE_SETTINGS)
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

    def get_sanitized_cache_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.CACHE_NAMESPACE)
        return self.sanitize_cache_settings(raw)

    def sanitize_library_settings(self, overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        defaults = self.system_defaults(self.LIBRARY_NAMESPACE)
        hidden = self._normalize_library_hidden_sections(defaults.get("hidden_sections", []))
        page_size = self._normalize_library_page_size(defaults.get("section_page_size"), defaults.get("section_page_size"))
        section_view = self._normalize_library_section_view(defaults.get("default_section_view"), "library")

        if overrides:
            if "hidden_sections" in overrides:
                hidden = self._normalize_library_hidden_sections(overrides.get("hidden_sections"))
            if "section_page_size" in overrides:
                page_size = self._normalize_library_page_size(overrides.get("section_page_size"), defaults.get("section_page_size"))
            if "default_section_view" in overrides:
                section_view = self._normalize_library_section_view(
                    overrides.get("default_section_view"),
                    section_view,
                )

        return {
            "hidden_sections": hidden,
            "section_page_size": page_size,
            "default_section_view": section_view,
        }

    def get_sanitized_library_settings(self) -> Dict[str, Any]:
        raw = self.get_system_settings(self.LIBRARY_NAMESPACE)
        return self.sanitize_library_settings(raw)

    def _transcoder_defaults(self) -> Dict[str, Any]:
        video_defaults = VideoEncodingOptions()
        audio_defaults = AudioEncodingOptions()

        video_filters = tuple(video_defaults.filters)
        if video_filters == ("scale=1920:-2",):
            scale_preset = "1080p"
        elif video_filters == ("scale=1280:-2",):
            scale_preset = "720p"
        elif not video_filters:
            scale_preset = "source"
        else:
            scale_preset = "custom"

        return {
            "TRANSCODER_PUBLISH_BASE_URL": os.getenv("TRANSCODER_PUBLISH_BASE_URL"),
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

        self._ensure_namespace_defaults(self.TRANSCODER_NAMESPACE, self._transcoder_defaults())
        self._ensure_namespace_defaults(self.CHAT_NAMESPACE, dict(self.DEFAULT_CHAT_SETTINGS))
        self._ensure_namespace_defaults(self.USERS_NAMESPACE, dict(self.DEFAULT_USERS_SETTINGS))
        self._ensure_namespace_defaults(self.PLEX_NAMESPACE, dict(self.DEFAULT_PLEX_SETTINGS))
        library_defaults = dict(self.DEFAULT_LIBRARY_SETTINGS)
        if not isinstance(library_defaults.get("hidden_sections"), list):
            library_defaults["hidden_sections"] = []
        else:
            library_defaults["hidden_sections"] = list(library_defaults["hidden_sections"])
        default_view = library_defaults.get("default_section_view")
        library_defaults["default_section_view"] = self._normalize_library_section_view(default_view, "library")
        self._ensure_namespace_defaults(self.LIBRARY_NAMESPACE, library_defaults)
        cache_defaults = dict(self.DEFAULT_CACHE_SETTINGS)
        self._ensure_namespace_defaults(self.CACHE_NAMESPACE, cache_defaults)

    def _ensure_namespace_defaults(self, namespace: str, defaults: Mapping[str, Any]) -> None:
        existing = {
            setting.key: setting
            for setting in SystemSetting.query.filter_by(namespace=namespace).all()
        }
        changed = False
        for key, value in defaults.items():
            if key in existing:
                continue
            db.session.add(SystemSetting(namespace=namespace, key=key, value=value))
            changed = True
        if changed:
            db.session.commit()

    def get_system_settings(self, namespace: str) -> Dict[str, Any]:
        stmt = select(SystemSetting).filter(SystemSetting.namespace == namespace)
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
            section_page_size = self.DEFAULT_LIBRARY_SETTINGS.get("section_page_size")
            default_view = self.DEFAULT_LIBRARY_SETTINGS.get("default_section_view")
            normalized_hidden = list(hidden) if isinstance(hidden, (list, tuple, set)) else []
            return {
                "hidden_sections": normalized_hidden,
                "section_page_size": section_page_size,
                "default_section_view": self._normalize_library_section_view(default_view, "library"),
            }
        if namespace == self.CACHE_NAMESPACE:
            defaults = self.sanitize_cache_settings(self.DEFAULT_CACHE_SETTINGS)
            return {
                "redis_url": defaults.get("redis_url", ""),
                "max_entries": defaults.get("max_entries", 0),
                "ttl_seconds": defaults.get("ttl_seconds", 0),
            }
        return {}

    def set_system_setting(
        self,
        namespace: str,
        key: str,
        value: Any,
        *,
        updated_by: Optional[User] = None,
    ) -> SystemSetting:
        record = SystemSetting.query.filter_by(namespace=namespace, key=key).first()
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
                db.session.add(UserSetting(user_id=user.id, namespace=namespace, key=key, value=value))
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
        record = UserSetting.query.filter_by(user_id=user.id, namespace=namespace, key=key).first()
        if not record:
            record = UserSetting(user_id=user.id, namespace=namespace, key=key)
        record.value = value
        db.session.add(record)
        db.session.commit()
        return record


__all__ = ["SettingsService"]
