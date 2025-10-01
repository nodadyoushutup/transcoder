"""Helpers for persisting system-wide and per-user settings."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from sqlalchemy import select

from ..extensions import db
from ..models import SystemSetting, User, UserSetting


class SettingsService:
    """High level persistence helpers for settings and user preferences."""

    TRANSCODER_NAMESPACE = "transcoder"
    CHAT_NAMESPACE = "chat"
    USERS_NAMESPACE = "users"
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

    def _transcoder_defaults(self) -> Dict[str, Any]:
        project_root = Path(__file__).resolve().parents[3]
        core_root = project_root / "core"
        return {
            "TRANSCODER_INPUT": os.getenv("TRANSCODER_INPUT", "/media/tmp/pulpfiction.mkv"),
            "TRANSCODER_OUTPUT": os.getenv("TRANSCODER_OUTPUT", str(core_root / "out")),
            "TRANSCODER_OUTPUT_BASENAME": os.getenv("TRANSCODER_OUTPUT_BASENAME", "audio_video"),
            "TRANSCODER_PUBLISH_BASE_URL": os.getenv("TRANSCODER_PUBLISH_BASE_URL"),
            "TRANSCODER_LOCAL_MEDIA_BASE_URL": os.getenv(
                "TRANSCODER_LOCAL_MEDIA_BASE_URL",
                "http://localhost:5001/media/",
            ),
            "TRANSCODER_CORS_ORIGIN": os.getenv("TRANSCODER_CORS_ORIGIN", "*"),
        }

    def ensure_defaults(self) -> None:
        """Seed the system with baseline settings if empty."""

        self._ensure_namespace_defaults(self.TRANSCODER_NAMESPACE, self._transcoder_defaults())
        self._ensure_namespace_defaults(self.CHAT_NAMESPACE, dict(self.DEFAULT_CHAT_SETTINGS))
        self._ensure_namespace_defaults(self.USERS_NAMESPACE, dict(self.DEFAULT_USERS_SETTINGS))

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
