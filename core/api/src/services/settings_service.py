"""Helpers for persisting system-wide and per-user settings."""
from __future__ import annotations

import os
from typing import Any, Dict, Mapping, Optional, Sequence

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
