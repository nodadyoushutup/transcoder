"""Service helpers around the ``User`` model."""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash

from ..extensions import db
from ..models import User


class UserService:
    """Persistence layer for user accounts backed by SQLAlchemy."""

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
            return existing
        return self.create_user(username=username, email=email_value, password=password, is_admin=True)


__all__ = ["UserService"]
