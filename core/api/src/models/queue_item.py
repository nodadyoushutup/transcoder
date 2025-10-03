"""Queue item database model."""
from __future__ import annotations

from datetime import datetime

from ..extensions import db
from .base import BaseModel


class QueueItem(BaseModel):
    """Represents a pending media item in the playback queue."""

    __tablename__ = "queue_items"

    rating_key = db.Column(db.String(64), nullable=False, index=True)
    part_id = db.Column(db.String(64), nullable=True)
    library_section_id = db.Column(db.Integer, nullable=True, index=True)
    duration_ms = db.Column(db.BigInteger, nullable=True)
    title = db.Column(db.String(255), nullable=True)
    grandparent_title = db.Column(db.String(255), nullable=True)
    thumb = db.Column(db.String(255), nullable=True)
    art = db.Column(db.String(255), nullable=True)
    data = db.Column(db.JSON, nullable=True)
    position = db.Column(db.Integer, nullable=False, index=True)
    requested_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    requested_by = db.relationship("User", backref=db.backref("queue_items", lazy="dynamic"))
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


__all__ = ["QueueItem"]
