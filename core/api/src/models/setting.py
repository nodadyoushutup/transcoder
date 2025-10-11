"""Generic settings models for system-wide and per-user preferences."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict

from sqlalchemy import func

from ..app.providers import db
from .base import BaseModel


@dataclass
class SystemSetting(BaseModel):
    """Represents a key/value configuration entry scoped to the whole system."""

    __tablename__ = "system_settings"

    namespace = db.Column(db.String(64), nullable=False, index=True)
    key = db.Column(db.String(120), nullable=False)
    value = db.Column(db.JSON, nullable=True)
    updated_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    updated_by = db.relationship("User", backref=db.backref("updated_settings", lazy="dynamic"))

    __table_args__ = (
        db.UniqueConstraint("namespace", "key", name="uq_system_setting"),
    )

    def to_dict(self) -> Dict[str, Any]:
        updated_at_value = self.updated_at if isinstance(self.updated_at, datetime) else None
        return {
            "id": int(self.id),
            "namespace": self.namespace,
            "key": self.key,
            "value": self.value,
            "updated_at": updated_at_value.isoformat() if updated_at_value else None,
            "updated_by": int(self.updated_by_id) if self.updated_by_id is not None else None,
        }


@dataclass
class UserSetting(BaseModel):
    """Represents a key/value pair storing preferences for a specific user."""

    __tablename__ = "user_settings"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace = db.Column(db.String(64), nullable=False, index=True)
    key = db.Column(db.String(120), nullable=False)
    value = db.Column(db.JSON, nullable=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    user = db.relationship("User", backref=db.backref("settings", lazy="dynamic"))

    __table_args__ = (
        db.UniqueConstraint("user_id", "namespace", "key", name="uq_user_setting"),
    )

    def to_dict(self) -> Dict[str, Any]:
        updated_at_value = self.updated_at if isinstance(self.updated_at, datetime) else None
        return {
            "id": int(self.id),
            "user_id": int(self.user_id),
            "namespace": self.namespace,
            "key": self.key,
            "value": self.value,
            "updated_at": updated_at_value.isoformat() if updated_at_value else None,
        }


__all__ = ["SystemSetting", "UserSetting"]

