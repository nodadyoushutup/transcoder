"""Authorization-related database models."""
from __future__ import annotations

from dataclasses import dataclass

from ..app.providers import db
from .base import BaseModel


@dataclass
class Permission(BaseModel):
    """Represents a single permission that can be granted to user groups."""

    __tablename__ = "permissions"

    name = db.Column(db.String(150), unique=True, nullable=False)
    description = db.Column(db.String(255), nullable=True)

    groups = db.relationship(
        "UserGroup",
        secondary="user_group_permissions",
        back_populates="permissions",
        lazy="selectin",
    )


@dataclass
class UserGroup(BaseModel):
    """Collection of permissions that can be assigned to users."""

    __tablename__ = "user_groups"

    name = db.Column(db.String(120), unique=True, nullable=False)
    slug = db.Column(db.String(64), unique=True, nullable=False, index=True)
    description = db.Column(db.String(255), nullable=True)
    is_system = db.Column(db.Boolean, nullable=False, default=False)

    permissions = db.relationship(
        Permission,
        secondary="user_group_permissions",
        back_populates="groups",
        order_by="Permission.name",
        lazy="selectin",
    )

    users = db.relationship(
        "User",
        secondary="user_group_memberships",
        back_populates="groups",
        lazy="selectin",
    )


class UserGroupPermission(BaseModel):
    """Join table connecting user groups to permissions."""

    __tablename__ = "user_group_permissions"

    group_id = db.Column(
        db.Integer,
        db.ForeignKey("user_groups.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    permission_id = db.Column(
        db.Integer,
        db.ForeignKey("permissions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    __table_args__ = (
        db.UniqueConstraint("group_id", "permission_id", name="uq_group_permission"),
    )


class UserGroupMembership(BaseModel):
    """Join table connecting users to the groups they belong to."""

    __tablename__ = "user_group_memberships"

    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    group_id = db.Column(
        db.Integer,
        db.ForeignKey("user_groups.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    __table_args__ = (
        db.UniqueConstraint("user_id", "group_id", name="uq_user_group_membership"),
    )


__all__ = [
    "Permission",
    "UserGroup",
    "UserGroupPermission",
    "UserGroupMembership",
]

