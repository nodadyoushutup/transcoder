"""In-memory tracking helpers for active viewers and guests."""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from typing import Dict, Iterable, Optional

from ..models import User


@dataclass
class ViewerRecord:
    """Represents a single active viewer session."""

    token: str
    last_seen: float
    username: str
    is_guest: bool
    user_id: Optional[int] = None
    is_admin: bool = False


class ViewerService:
    """Tracks active viewers (authenticated users and guests)."""

    def __init__(self, *, ttl_seconds: int = 30) -> None:
        self._records: Dict[str, ViewerRecord] = {}
        self._ttl = ttl_seconds
        self._lock = threading.Lock()

    @staticmethod
    def generate_guest_name() -> str:
        return f"Anonymous{secrets.randbelow(900000) + 100000}"

    def _generate_token(self) -> str:
        return secrets.token_urlsafe(24)

    def _cleanup(self, now: Optional[float] = None) -> None:
        current = now or time.time()
        expired: Iterable[str] = [
            token for token, record in self._records.items() if current - record.last_seen > self._ttl
        ]
        for token in expired:
            self._records.pop(token, None)

    def register(self, *, user: Optional[User], username: str, token: Optional[str] = None) -> ViewerRecord:
        """Register (or refresh) a viewer and return the active record."""

        now = time.time()
        with self._lock:
            self._cleanup(now)
            record_token = token or self._generate_token()
            record = ViewerRecord(
                token=record_token,
                last_seen=now,
                username=username,
                is_guest=user is None,
                user_id=None if user is None else int(user.id),
                is_admin=bool(getattr(user, "is_admin", False)) if user is not None else False,
            )
            self._records[record_token] = record
            return record

    def heartbeat(self, token: str, *, user: Optional[User] = None, username: Optional[str] = None) -> Optional[ViewerRecord]:
        now = time.time()
        with self._lock:
            record = self._records.get(token)
            if not record:
                if username is None:
                    return None
                record = ViewerRecord(
                    token=token,
                    last_seen=now,
                    username=username,
                    is_guest=user is None,
                    user_id=None if user is None else int(user.id),
                    is_admin=bool(getattr(user, "is_admin", False)) if user is not None else False,
                )
                self._records[token] = record
                return record
            if username:
                record.username = username
            if user is not None:
                record.user_id = int(user.id)
                record.is_guest = False
                record.is_admin = bool(getattr(user, "is_admin", False))
            record.last_seen = now
            return record

    def list_active(self) -> Dict[str, object]:
        now = time.time()
        with self._lock:
            self._cleanup(now)
            users_dict: Dict[int, ViewerRecord] = {}
            guest_count = 0
            for record in self._records.values():
                if record.user_id is not None:
                    users_dict.setdefault(record.user_id, record)
                else:
                    guest_count += 1
            users = [
                {
                    "user_id": record.user_id,
                    "username": record.username,
                    "is_admin": record.is_admin,
                }
                for record in users_dict.values()
            ]
            users.sort(key=lambda item: item["username"].lower())
            signed_in_count = len(users)
            total_count = signed_in_count + guest_count
            return {
                "users": users,
                "guest_count": guest_count,
                "signed_in_count": signed_in_count,
                "total_count": total_count,
            }


__all__ = ["ViewerService", "ViewerRecord"]
