"""Database model for chat messages."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func

from ..extensions import db


@dataclass
class ChatMessage(db.Model):
    """Represents a single chat message persisted in the database."""

    __tablename__ = "chat_messages"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    username = db.Column(db.String(150), nullable=False, index=True)
    body = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())

    user = db.relationship("User", backref=db.backref("chat_messages", lazy="dynamic"))

    def to_dict(self) -> dict[str, Any]:
        created_at: datetime
        if isinstance(self.created_at, datetime):
            created_at = self.created_at
        else:  # pragma: no cover - SQLAlchemy may defer hydration
            created_at = datetime.utcnow()
        return {
            "id": int(self.id),
            "user_id": int(self.user_id),
            "username": self.username,
            "body": self.body,
            "created_at": created_at.isoformat(),
        }


__all__ = ["ChatMessage"]
