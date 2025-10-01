"""Chat persistence helpers."""
from __future__ import annotations

from typing import Iterable, List, Optional, Sequence

from sqlalchemy import inspect, select, text
from sqlalchemy.orm import selectinload

from ..extensions import db
from ..models import ChatAttachment, ChatMention, ChatMessage, ChatReaction, User


def ensure_chat_schema() -> None:
    engine = db.get_engine()
    inspector = inspect(engine)

    existing_tables = set(inspector.get_table_names())
    if "chat_attachments" not in existing_tables:
        ChatAttachment.__table__.create(bind=engine)
    if "chat_reactions" not in existing_tables:
        ChatReaction.__table__.create(bind=engine)
    if "chat_mentions" not in existing_tables:
        ChatMention.__table__.create(bind=engine)

    columns = {col["name"] for col in inspector.get_columns("chat_messages")}
    if "updated_at" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN updated_at DATETIME"))
            conn.execute(text("UPDATE chat_messages SET updated_at = created_at WHERE updated_at IS NULL"))
    if "sender_key" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN sender_key VARCHAR(64)"))
            conn.execute(
                text(
                    "UPDATE chat_messages SET sender_key = CASE WHEN user_id IS NOT NULL THEN 'user:' || user_id ELSE '' END"
                )
            )
            conn.execute(
                text("CREATE INDEX IF NOT EXISTS ix_chat_messages_sender_key ON chat_messages (sender_key)")
            )


class ChatService:
    """Encapsulates chat message CRUD operations."""

    def create_message(
        self,
        *,
        user: User,
        username: str,
        sender_key: str,
        body: str,
        attachments: Optional[Sequence[ChatAttachment]] = None,
        mentions: Optional[Sequence[User]] = None,
    ) -> ChatMessage:
        message = ChatMessage(
            user_id=user.id,
            username=username,
            sender_key=sender_key,
            body=body.strip(),
        )
        if attachments:
            message.attachments.extend(attachments)
        if mentions:
            for mentioned_user in mentions:
                message.mentions.append(ChatMention(user_id=mentioned_user.id))
        db.session.add(message)
        db.session.commit()
        db.session.refresh(message)
        return message

    def update_message(
        self,
        message: ChatMessage,
        *,
        body: str,
        mentions: Optional[Sequence[User]] = None,
    ) -> ChatMessage:
        message.body = body.strip()
        if mentions is not None:
            desired_ids = {user.id for user in mentions}
            existing_map = {mention.user_id: mention for mention in message.mentions}
            for mention in list(message.mentions):
                if mention.user_id not in desired_ids:
                    message.mentions.remove(mention)
                    db.session.delete(mention)
            for user in mentions:
                if user.id not in existing_map:
                    message.mentions.append(ChatMention(user_id=user.id))
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
            selectinload(ChatMessage.user),
            selectinload(ChatMessage.attachments),
            selectinload(ChatMessage.reactions).selectinload(ChatReaction.user),
            selectinload(ChatMessage.mentions).selectinload(ChatMention.user),
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
                selectinload(ChatMessage.user),
                selectinload(ChatMessage.attachments),
                selectinload(ChatMessage.reactions).selectinload(ChatReaction.user),
                selectinload(ChatMessage.mentions).selectinload(ChatMention.user),
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


__all__ = ["ChatService", "ChatAttachment", "ChatReaction", "ChatMention", "ensure_chat_schema"]
