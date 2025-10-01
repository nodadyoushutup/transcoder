"""Database model for authenticated users."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Set

from flask_login import UserMixin

from ..extensions import db
from .base import BaseModel


@dataclass
class User(UserMixin, BaseModel):
    """User record persisted via SQLAlchemy."""

    __tablename__ = "users"
    username = db.Column(db.String(150), unique=True, nullable=False)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)
    avatar_path = db.Column(db.String(512), nullable=True)

    groups = db.relationship(
        "UserGroup",
        secondary="user_group_memberships",
        back_populates="users",
        lazy="selectin",
    )

    def to_public_dict(self) -> dict[str, Any]:
        avatar_url = f"/users/{int(self.id)}/avatar" if self.avatar_path else None
        group_payload = [
            {
                "id": int(group.id),
                "name": group.name,
                "slug": group.slug,
                "is_system": bool(group.is_system),
            }
            for group in sorted(self.groups, key=lambda item: item.name.lower())
        ]
        return {
            "id": int(self.id),
            "username": self.username,
            "email": self.email,
            "is_admin": bool(self.is_admin),
            "avatar_url": avatar_url,
            "groups": group_payload,
            "permissions": sorted(self.permission_names()),
        }

    def permission_names(self) -> Set[str]:
        if self.is_admin:
            return {"*"}
        names: Set[str] = set()
        for group in self.groups:
            names.update(permission.name for permission in group.permissions)
        return names

    def has_permission(self, permission: str | Iterable[str]) -> bool:
        if self.is_admin:
            return True
        if isinstance(permission, str):
            return permission in self.permission_names()
        names = self.permission_names()
        return any(item in names for item in permission)


__all__ = ["User"]
