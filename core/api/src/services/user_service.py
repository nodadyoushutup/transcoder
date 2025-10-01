"""Service helpers around the ``User`` model."""
from __future__ import annotations

from typing import Iterable, List, Optional, Sequence, TYPE_CHECKING

import secrets

from sqlalchemy import func, inspect, select, text
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash

from ..extensions import db
from ..models import User

if TYPE_CHECKING:  # pragma: no cover - type checking hint only
    from .group_service import GroupService
    from .settings_service import SettingsService


class UserService:
    """Persistence layer for user accounts backed by SQLAlchemy."""

    def __init__(
        self,
        *,
        group_service: Optional[GroupService] = None,
        settings_service: Optional[SettingsService] = None,
    ) -> None:
        self._groups = group_service
        self._settings = settings_service

    def prepare_schema(self) -> None:
        """Ensure the ``users`` table matches the expected schema."""

        engine = db.get_engine()
        inspector = inspect(engine)
        tables = {table_name for table_name in inspector.get_table_names()}
        if "users" not in tables:
            return
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "avatar_path" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN avatar_path VARCHAR(512)"))

    def get_by_id(self, user_id: int) -> Optional[User]:
        return db.session.get(User, user_id)

    def get_by_username(self, username: str) -> Optional[User]:
        if not username:
            return None
        return User.query.filter_by(username=username).first()

    def get_by_email(self, email: str) -> Optional[User]:
        if not email:
            return None
        return User.query.filter_by(email=email.lower()).first()

    def get_by_ids(self, user_ids: Iterable[int]) -> list[User]:
        identifiers = {int(user_id) for user_id in user_ids if user_id is not None}
        if not identifiers:
            return []
        stmt = select(User).filter(User.id.in_(identifiers))
        return list(db.session.execute(stmt).scalars())

    def get_by_usernames(self, usernames: Iterable[str]) -> list[User]:
        normalized = {name.strip().lower() for name in usernames if name}
        if not normalized:
            return []
        stmt = select(User).filter(func.lower(User.username).in_(normalized))
        return list(db.session.execute(stmt).scalars())

    def get_by_identifier(self, identifier: str) -> Optional[User]:
        ident = identifier.strip()
        if not ident:
            return None
        user = self.get_by_username(ident)
        if user:
            return user
        return self.get_by_email(ident)

    def create_user(
        self,
        *,
        username: str,
        email: str,
        password: str,
        is_admin: bool = False,
        group_slugs: Optional[Sequence[str]] = None,
    ) -> User:
        email_value = email.strip().lower()
        user = User(
            username=username.strip(),
            email=email_value,
            password_hash=generate_password_hash(password),
            is_admin=is_admin,
        )
        db.session.add(user)
        try:
            db.session.commit()
        except IntegrityError as exc:  # pragma: no cover - thin wrapper
            db.session.rollback()
            message = str(getattr(exc, "orig", exc)).lower()
            if "username" in message:
                raise ValueError("username already exists") from exc
            if "email" in message:
                raise ValueError("email already exists") from exc
            raise ValueError("unable to create user") from exc

        if self._groups:
            default_groups: Iterable[str]
            if is_admin:
                default_groups = ("admin",)
            elif group_slugs:
                default_groups = group_slugs
            else:
                default_groups = (self._groups.default_user_slug,)
            self._groups.assign_user_to_groups(user, default_groups, commit=True)

        if self._settings:
            self._settings.ensure_user_defaults(user)

        return user

    def verify(self, identifier: str, password: str) -> Optional[User]:
        user = self.get_by_identifier(identifier)
        if not user:
            return None
        if not check_password_hash(user.password_hash, password):
            return None
        return user

    def ensure_admin(self, username: str, password: str, email: Optional[str] = None) -> User:
        email_value = (email or f"{username}@example.com").strip().lower()
        existing = self.get_by_username(username)
        if existing:
            updated = False
            if not existing.is_admin:
                existing.is_admin = True
                updated = True
            if not check_password_hash(existing.password_hash, password):
                existing.password_hash = generate_password_hash(password)
                updated = True
            if existing.email != email_value:
                existing.email = email_value
                updated = True
            if updated:
                db.session.add(existing)
                try:
                    db.session.commit()
                except IntegrityError as exc:  # pragma: no cover - thin wrapper
                    db.session.rollback()
                    raise ValueError("unable to update admin user") from exc
            admin_user = existing
        else:
            admin_user = self.create_user(
                username=username,
                email=email_value,
                password=password,
                is_admin=True,
                group_slugs=("admin",),
            )

        if self._groups:
            self._groups.assign_user_to_groups(admin_user, ("admin",), commit=True)

        if self._settings:
            self._settings.ensure_user_defaults(admin_user)

        return admin_user

    def get_guest_placeholder(self) -> User:
        username = "__guest__"
        guest = self.get_by_username(username)
        if guest:
            return guest

        email_value = "guest@publex.local"
        password = secrets.token_urlsafe(32)
        guest = User(
            username=username,
            email=email_value,
            password_hash=generate_password_hash(password),
            is_admin=False,
        )
        db.session.add(guest)
        db.session.commit()
        if self._groups:
            self._groups.assign_user_to_groups(guest, (self._groups.default_user_slug,), commit=True)
        if self._settings:
            self._settings.ensure_user_defaults(guest)
        return guest

    def list_users(self) -> List[User]:
        stmt = (
            select(User)
            .filter(func.lower(User.username) != "__guest__")
            .order_by(func.lower(User.username))
        )
        return list(db.session.execute(stmt).scalars())

    def update_profile(
        self,
        user: User,
        *,
        username: Optional[str] = None,
        email: Optional[str] = None,
    ) -> User:
        changed = False
        if username and username.strip() and username.strip() != user.username:
            existing = self.get_by_username(username.strip())
            if existing and existing.id != user.id:
                raise ValueError("username already exists")
            user.username = username.strip()
            changed = True
        if email and email.strip():
            normalized = email.strip().lower()
            if normalized != user.email:
                existing = self.get_by_email(normalized)
                if existing and existing.id != user.id:
                    raise ValueError("email already exists")
                user.email = normalized
                changed = True
        if changed:
            db.session.add(user)
            db.session.commit()
        return user

    def change_password(self, user: User, current_password: str, new_password: str) -> None:
        if not check_password_hash(user.password_hash, current_password):
            raise ValueError("current password is incorrect")
        user.password_hash = generate_password_hash(new_password)
        db.session.add(user)
        db.session.commit()

    def set_user_groups(self, user: User, group_slugs: Sequence[str]) -> None:
        if not self._groups:
            return
        self._groups.assign_user_to_groups(user, group_slugs, replace=True, commit=True)


__all__ = ["UserService"]
