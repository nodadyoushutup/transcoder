"""Chat persistence helpers."""
from __future__ import annotations

from typing import Iterable, List, Optional, Sequence

from sqlalchemy import inspect, select, text
from sqlalchemy.orm import selectinload

from ..extensions import db
from ..models import ChatAttachment, ChatMessage, ChatReaction, User


def ensure_chat_schema() -> None:
    engine = db.get_engine()
    inspector = inspect(engine)

    existing_tables = set(inspector.get_table_names())
    if "chat_attachments" not in existing_tables:
        ChatAttachment.__table__.create(bind=engine)
    if "chat_reactions" not in existing_tables:
        ChatReaction.__table__.create(bind=engine)

    columns = {col["name"] for col in inspector.get_columns("chat_messages")}
    if "updated_at" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN updated_at DATETIME"))
            conn.execute(text("UPDATE chat_messages SET updated_at = created_at WHERE updated_at IS NULL"))


class ChatService:
    """Encapsulates chat message CRUD operations."""

    def create_message(
        self,
        *,
        user: User,
        body: str,
        attachments: Optional[Sequence[ChatAttachment]] = None,
    ) -> ChatMessage:
        message = ChatMessage(user_id=user.id, username=user.username, body=body.strip())
        if attachments:
            message.attachments.extend(attachments)
        db.session.add(message)
        db.session.commit()
        db.session.refresh(message)
        return message

    def update_message(self, message: ChatMessage, *, body: str) -> ChatMessage:
        message.body = body.strip()
        db.session.add(message)
        db.session.commit()
        db.session.refresh(message)
        return message

    def delete_message(self, message: ChatMessage) -> None:
        db.session.delete(message)
        db.session.commit()

    def fetch_messages(
        self,
        *,
        limit: int = 50,
        before_id: Optional[int] = None,
    ) -> tuple[List[ChatMessage], bool]:
        query = select(ChatMessage).options(
            selectinload(ChatMessage.attachments),
            selectinload(ChatMessage.reactions).selectinload(ChatReaction.user),
        )
        if before_id is not None:
            query = query.filter(ChatMessage.id < before_id)
        query = query.order_by(ChatMessage.id.desc()).limit(limit + 1)
        results: Iterable[ChatMessage] = db.session.execute(query).scalars()
        ordered = list(results)
        has_more = len(ordered) > limit
        sliced = ordered[:limit]
        sliced.reverse()
        return sliced, has_more

    def get_message(self, message_id: int) -> Optional[ChatMessage]:
        stmt = (
            select(ChatMessage)
            .options(
                selectinload(ChatMessage.attachments),
                selectinload(ChatMessage.reactions).selectinload(ChatReaction.user),
            )
            .filter(ChatMessage.id == message_id)
            .limit(1)
        )
        return db.session.execute(stmt).scalar_one_or_none()

    def add_reaction(self, message: ChatMessage, user: User, emoji: str) -> ChatReaction:
        existing = (
            ChatReaction.query.filter_by(message_id=message.id, user_id=user.id, emoji=emoji).first()
        )
        if existing:
            return existing
        reaction = ChatReaction(message_id=message.id, user_id=user.id, emoji=emoji)
        db.session.add(reaction)
        db.session.commit()
        db.session.refresh(reaction)
        return reaction

    def remove_reaction(self, message: ChatMessage, user: User, emoji: str) -> bool:
        reaction = ChatReaction.query.filter_by(
            message_id=message.id, user_id=user.id, emoji=emoji
        ).first()
        if not reaction:
            return False
        db.session.delete(reaction)
        db.session.commit()
        return True


__all__ = ["ChatService", "ChatAttachment", "ChatReaction", "ensure_chat_schema"]
