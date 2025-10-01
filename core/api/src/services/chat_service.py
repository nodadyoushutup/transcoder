"""Chat persistence helpers."""
from __future__ import annotations

from typing import Iterable, List, Optional

from ..extensions import db
from ..models import ChatMessage, User


class ChatService:
    """Encapsulates chat message CRUD operations."""

    def create_message(self, *, user: User, body: str) -> ChatMessage:
        message = ChatMessage(user_id=user.id, username=user.username, body=body.strip())
        db.session.add(message)
        db.session.commit()
        db.session.refresh(message)
        return message

    def fetch_messages(
        self,
        *,
        limit: int = 50,
        before_id: Optional[int] = None,
    ) -> tuple[List[ChatMessage], bool]:
        query = ChatMessage.query
        if before_id is not None:
            query = query.filter(ChatMessage.id < before_id)
        query = query.order_by(ChatMessage.id.desc()).limit(limit + 1)
        results: Iterable[ChatMessage] = query
        ordered = list(results)
        has_more = len(ordered) > limit
        sliced = ordered[:limit]
        sliced.reverse()
        return sliced, has_more


__all__ = ["ChatService"]
