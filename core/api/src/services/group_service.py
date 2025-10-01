"""Helpers for managing user groups and permissions."""
from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import joinedload

from ..extensions import db
from ..models import Permission, User, UserGroup


class GroupService:
    """Encapsulates CRUD logic for user groups and their permissions."""

    ADMIN_SLUG = "admin"
    MODERATOR_SLUG = "moderator"
    USER_SLUG = "user"
    GUEST_SLUG = "guest"
    RESERVED_SLUGS = {ADMIN_SLUG, MODERATOR_SLUG, USER_SLUG, GUEST_SLUG}

    DEFAULT_PERMISSIONS: Sequence[tuple[str, str]] = (
        ("system.settings.manage", "Manage all system-wide settings."),
        ("users.manage", "Manage user accounts and group membership."),
        ("chat.settings.manage", "Manage chat-level configuration."),
        ("chat.message.edit.any", "Edit any chat message."),
        ("chat.message.delete.any", "Delete any chat message."),
        ("transcoder.settings.manage", "Manage transcoder configuration."),
    )

    DEFAULT_GROUPS: Sequence[dict[str, object]] = (
        {
            "name": "Administrator",
            "slug": ADMIN_SLUG,
            "description": "Full access to manage Publex and all connected services.",
            "is_system": True,
            "permissions": [item[0] for item in DEFAULT_PERMISSIONS],
        },
        {
            "name": "Moderator",
            "slug": MODERATOR_SLUG,
            "description": "Moderate chat activity and assist with community management.",
            "is_system": True,
            "permissions": [
                "chat.message.edit.any",
                "chat.message.delete.any",
                "chat.settings.manage",
            ],
        },
        {
            "name": "User",
            "slug": USER_SLUG,
            "description": "Standard access for signed-in users.",
            "is_system": True,
            "permissions": [],
        },
        {
            "name": "Guest",
            "slug": GUEST_SLUG,
            "description": "Limited access for unauthenticated viewers.",
            "is_system": True,
            "permissions": [],
        },
    )

    @property
    def default_user_slug(self) -> str:
        return self.USER_SLUG

    def ensure_defaults(self) -> None:
        """Create baseline permissions and groups if they are missing."""

        changed = False

        permissions: Dict[str, Permission] = {
            permission.name: permission
            for permission in Permission.query.all()
        }

        for name, description in self.DEFAULT_PERMISSIONS:
            permission = permissions.get(name)
            if not permission:
                permission = Permission(name=name, description=description)
                db.session.add(permission)
                permissions[name] = permission
                changed = True
            elif description and permission.description != description:
                permission.description = description
                db.session.add(permission)
                changed = True

        groups: Dict[str, UserGroup] = {
            group.slug: group
            for group in UserGroup.query.options(joinedload(UserGroup.permissions)).all()
        }

        for group_def in self.DEFAULT_GROUPS:
            slug = str(group_def["slug"])
            name = str(group_def["name"])
            description = str(group_def.get("description", ""))
            is_system = bool(group_def.get("is_system", False))
            desired_permission_names: List[str] = list(group_def.get("permissions", []))

            group = groups.get(slug)
            if not group:
                group = UserGroup(
                    name=name,
                    slug=slug,
                    description=description,
                    is_system=is_system,
                )
                db.session.add(group)
                groups[slug] = group
                changed = True
            else:
                if group.name != name:
                    group.name = name
                    changed = True
                if group.description != description:
                    group.description = description
                    changed = True
                if group.is_system != is_system:
                    group.is_system = is_system
                    changed = True

            current_names = {perm.name for perm in group.permissions}
            for perm_name in desired_permission_names:
                permission = permissions.get(perm_name)
                if not permission:
                    continue
                if perm_name not in current_names:
                    group.permissions.append(permission)
                    current_names.add(perm_name)
                    changed = True

        if changed:
            db.session.commit()

    def list_groups(self) -> list[UserGroup]:
        stmt = select(UserGroup).order_by(UserGroup.name.asc())
        return list(db.session.execute(stmt).scalars())

    def get_group_by_slug(self, slug: str) -> Optional[UserGroup]:
        if not slug:
            return None
        return UserGroup.query.filter_by(slug=slug).first()

    def assign_user_to_groups(
        self,
        user: User,
        group_slugs: Iterable[str],
        *,
        replace: bool = False,
        commit: bool = False,
    ) -> None:
        resolved_groups: List[UserGroup] = []
        seen_ids = set()
        for slug in group_slugs:
            group = self.get_group_by_slug(slug)
            if not group or group.id in seen_ids:
                continue
            resolved_groups.append(group)
            seen_ids.add(group.id)

        if not resolved_groups:
            return

        if replace:
            user.groups = resolved_groups
        else:
            current_ids = {group.id for group in user.groups}
            for group in resolved_groups:
                if group.id not in current_ids:
                    user.groups.append(group)

        db.session.add(user)
        if commit:
            db.session.commit()

    def list_permissions(self) -> List[Permission]:
        stmt = select(Permission).order_by(Permission.name.asc())
        return list(db.session.execute(stmt).scalars())

    def get_group_by_id(self, group_id: int) -> Optional[UserGroup]:
        if not group_id:
            return None
        return UserGroup.query.get(group_id)

    def create_group(
        self,
        *,
        name: str,
        description: Optional[str] = None,
        permissions: Optional[Sequence[str]] = None,
    ) -> UserGroup:
        slug = self._unique_slug(name)
        if slug in self.RESERVED_SLUGS:
            raise ValueError("slug is reserved")
        group = UserGroup(name=name.strip(), slug=slug, description=(description or ""), is_system=False)
        if permissions:
            for perm_name in permissions:
                permission = Permission.query.filter_by(name=perm_name).first()
                if not permission:
                    raise ValueError(f"unknown permission '{perm_name}'")
                group.permissions.append(permission)
        db.session.add(group)
        db.session.commit()
        return group

    def update_group(
        self,
        group: UserGroup,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        permissions: Optional[Sequence[str]] = None,
    ) -> UserGroup:
        if group.slug in self.RESERVED_SLUGS:
            # Reserved groups have fixed slug but can update name/description/permissions.
            pass
        if name and name.strip() and group.name != name.strip():
            group.name = name.strip()
        if description is not None and group.description != description:
            group.description = description
        if permissions is not None:
            desired = {perm_name for perm_name in permissions if isinstance(perm_name, str)}
            current = {perm.name for perm in group.permissions}
            if desired != current:
                group.permissions.clear()
                for perm_name in sorted(desired):
                    permission = Permission.query.filter_by(name=perm_name).first()
                    if not permission:
                        raise ValueError(f"unknown permission '{perm_name}'")
                    group.permissions.append(permission)
        db.session.add(group)
        db.session.commit()
        return group

    def delete_group(self, group: UserGroup) -> None:
        if group.is_system or group.slug in self.RESERVED_SLUGS:
            raise ValueError("cannot delete system group")
        if group.users:
            raise ValueError("group has members and cannot be deleted")
        db.session.delete(group)
        db.session.commit()

    def _unique_slug(self, source: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "-", source.strip().lower()).strip("-") or "group"
        slug = base
        counter = 1
        while UserGroup.query.filter_by(slug=slug).first() is not None:
            counter += 1
            slug = f"{base}-{counter}"
        return slug


__all__ = ["GroupService"]
