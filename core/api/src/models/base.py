"""Shared base model helpers for SQLAlchemy models."""
from __future__ import annotations

from typing import Any, Iterable, Optional, Type, TypeVar

from ..app.providers import db

ModelType = TypeVar("ModelType", bound="BaseModel")


class BaseModel(db.Model):
    """Provides convenience helpers for CRUD operations."""

    __abstract__ = True

    id = db.Column(db.Integer, primary_key=True)

    @classmethod
    def get(cls: Type[ModelType], object_id: Any) -> Optional[ModelType]:
        return db.session.get(cls, object_id)

    @classmethod
    def create(cls: Type[ModelType], **attrs: Any) -> ModelType:
        instance = cls(**attrs)
        db.session.add(instance)
        db.session.commit()
        return instance

    def update(self: ModelType, **attrs: Any) -> ModelType:
        for key, value in attrs.items():
            setattr(self, key, value)
        db.session.add(self)
        db.session.commit()
        return self

    def delete(self) -> None:
        db.session.delete(self)
        db.session.commit()

    @classmethod
    def bulk_create(cls: Type[ModelType], objs: Iterable[ModelType]) -> None:
        db.session.add_all(list(objs))
        db.session.commit()


__all__ = ["BaseModel"]
