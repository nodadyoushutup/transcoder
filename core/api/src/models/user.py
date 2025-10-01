"""Database model for authenticated users."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from flask_login import UserMixin

from ..extensions import db


@dataclass
class User(UserMixin, db.Model):
    """User record persisted via SQLAlchemy."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "id": int(self.id),
            "username": self.username,
            "email": self.email,
            "is_admin": bool(self.is_admin),
        }


__all__ = ["User"]
