"""Database model for chat messages."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func

from ..extensions import db
from .base import BaseModel


@dataclass
class ChatAttachment(BaseModel):
    """Binary payload attached to a chat message."""

    __tablename__ = "chat_attachments"

    message_id = db.Column(db.Integer, db.ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False, index=True)
    file_path = db.Column(db.String(512), nullable=False)
    mime_type = db.Column(db.String(120), nullable=False)
    file_size = db.Column(db.Integer, nullable=False)
    original_name = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())


@dataclass
class ChatMessage(BaseModel):
    """Represents a single chat message persisted in the database."""

    __tablename__ = "chat_messages"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    username = db.Column(db.String(150), nullable=False, index=True)
    sender_key = db.Column(db.String(64), nullable=False, index=True, default="")
    body = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    user = db.relationship("User", backref=db.backref("chat_messages", lazy="dynamic"))
    attachments = db.relationship(
        ChatAttachment,
        backref="message",
        cascade="all, delete-orphan",
        order_by="ChatAttachment.id",
        lazy="selectin",
    )
    reactions = db.relationship(
        "ChatReaction",
        backref="message",
        cascade="all, delete-orphan",
        order_by="ChatReaction.id",
        lazy="selectin",
    )
    mentions = db.relationship(
        "ChatMention",
        backref="message",
        cascade="all, delete-orphan",
        order_by="ChatMention.id",
        lazy="selectin",
    )

    def to_dict(self) -> dict[str, Any]:
        created_at = self.created_at if isinstance(self.created_at, datetime) else datetime.utcnow()
        updated_at = self.updated_at if isinstance(self.updated_at, datetime) else created_at
        return {
            "id": int(self.id),
            "user_id": int(self.user_id),
            "username": self.username,
            "sender_key": self.sender_key or "",
            "body": self.body,
            "created_at": created_at.isoformat(),
            "updated_at": updated_at.isoformat(),
            "attachments": [
                {
                    "id": int(attachment.id),
                    "mime_type": attachment.mime_type,
                    "file_size": int(attachment.file_size),
                    "original_name": attachment.original_name,
                }
                for attachment in self.attachments
            ],
            "reactions": [
                {
                    "id": int(reaction.id),
                    "emoji": reaction.emoji,
                    "user_id": int(reaction.user_id),
                    "username": reaction.user.username if reaction.user else None,
                }
                for reaction in self.reactions
            ],
            "mentions": [
                {
                    "id": int(mention.id),
                    "user_id": int(mention.user_id),
                    "username": mention.user.username if mention.user else None,
                }
                for mention in self.mentions
            ],
            "is_guest": bool(self.sender_key.startswith("guest:")),
        }


@dataclass
class ChatReaction(BaseModel):
    """Emoji reaction appended to a chat message."""

    __tablename__ = "chat_reactions"

    message_id = db.Column(db.Integer, db.ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    emoji = db.Column(db.String(64), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())

    user = db.relationship("User", backref=db.backref("chat_reactions", lazy="dynamic"))

    __table_args__ = (db.UniqueConstraint("message_id", "user_id", "emoji", name="uq_chat_reaction"),)


@dataclass
class ChatMention(BaseModel):
    """Tracks which users were mentioned in a chat message."""

    __tablename__ = "chat_mentions"

    message_id = db.Column(
        db.Integer,
        db.ForeignKey("chat_messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())

    user = db.relationship("User", backref=db.backref("chat_mentions", lazy="dynamic"))

    __table_args__ = (
        db.UniqueConstraint("message_id", "user_id", name="uq_chat_mention"),
    )


__all__ = ["ChatMessage", "ChatAttachment", "ChatReaction", "ChatMention"]
