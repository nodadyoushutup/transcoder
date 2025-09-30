"""Authentication helpers for the transcoder backend."""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any, Optional

from flask import Blueprint, Flask, current_app, jsonify, request
from flask_login import (LoginManager, UserMixin, current_user, login_user,
                         logout_user)
from werkzeug.security import check_password_hash, generate_password_hash


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
);
"""


@dataclass
class User(UserMixin):
    """Simple user record backed by SQLite."""

    id: int
    username: str
    email: str
    password_hash: str
    is_admin: bool = False

    def get_id(self) -> str:  # type: ignore[override]
        return str(self.id)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "is_admin": bool(self.is_admin),
        }


class UserStore:
    """Persistence layer for user accounts."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _row_to_user(self, row: sqlite3.Row | None) -> Optional[User]:
        if row is None:
            return None
        return User(
            id=row["id"],
            username=row["username"],
            email=row["email"],
            password_hash=row["password_hash"],
            is_admin=bool(row["is_admin"]),
        )

    def get_by_id(self, user_id: int) -> Optional[User]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._row_to_user(row)

    def get_by_username(self, username: str) -> Optional[User]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return self._row_to_user(row)

    def get_by_email(self, email: str) -> Optional[User]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return self._row_to_user(row)

    def get_by_identifier(self, identifier: str) -> Optional[User]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username = ? OR email = ?",
                (identifier, identifier.lower()),
            ).fetchone()
        return self._row_to_user(row)

    def create_user(
        self,
        username: str,
        email: str,
        password: str,
        *,
        is_admin: bool = False,
    ) -> User:
        password_hash = generate_password_hash(password)
        email_value = email.lower()
        with self._connect() as conn:
            try:
                cursor = conn.execute(
                    "INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, ?)",
                    (username, email_value, password_hash, int(is_admin)),
                )
            except sqlite3.IntegrityError as exc:  # pragma: no cover - thin wrapper
                message = str(exc).lower()
                if "username" in message:
                    raise ValueError("username already exists") from exc
                if "email" in message:
                    raise ValueError("email already exists") from exc
                raise ValueError("unable to create user") from exc
            user_id = cursor.lastrowid
            conn.commit()
        return User(
            id=int(user_id),
            username=username,
            email=email_value,
            password_hash=password_hash,
            is_admin=is_admin,
        )

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
            update_fields = []
            params: list[Any] = []
            if not existing.is_admin:
                update_fields.append("is_admin = 1")
                existing.is_admin = True
            if not check_password_hash(existing.password_hash, password):
                new_hash = generate_password_hash(password)
                update_fields.append("password_hash = ?")
                params.append(new_hash)
                existing.password_hash = new_hash
            if existing.email != email_value:
                update_fields.append("email = ?")
                params.append(email_value)
                existing.email = email_value
            if update_fields:
                params.append(existing.id)
                with self._connect() as conn:
                    conn.execute(
                        f"UPDATE users SET {', '.join(update_fields)} WHERE id = ?",
                        tuple(params),
                    )
                    conn.commit()
            return existing
        return self.create_user(username=username, email=email_value, password=password, is_admin=True)


login_manager = LoginManager()
login_manager.login_view = None

AUTH_BLUEPRINT = Blueprint("auth", __name__, url_prefix="/auth")


def _store() -> UserStore:
    store: UserStore = current_app.extensions["transcoder_user_store"]
    return store


@AUTH_BLUEPRINT.post("/register")
def register() -> Any:
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    email = str(payload.get("email", "")).strip()
    password = str(payload.get("password", ""))
    if not username or not email or not password:
        return (
            jsonify({"error": "username, email, and password are required"}),
            HTTPStatus.BAD_REQUEST,
        )
    try:
        user = _store().create_user(username=username, email=email, password=password)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.CONFLICT
    login_user(user)
    return jsonify({"user": user.to_public_dict()}), HTTPStatus.CREATED


@AUTH_BLUEPRINT.post("/login")
def login() -> Any:
    payload = request.get_json(silent=True) or {}
    identifier = str(payload.get("identifier", "")).strip()
    password = str(payload.get("password", ""))
    if not identifier or not password:
        return jsonify({"error": "identifier and password are required"}), HTTPStatus.BAD_REQUEST
    user = _store().verify(identifier, password)
    if not user:
        return jsonify({"error": "invalid credentials"}), HTTPStatus.UNAUTHORIZED
    login_user(user)
    return jsonify({"user": user.to_public_dict()}), HTTPStatus.OK


@AUTH_BLUEPRINT.post("/logout")
def logout() -> Any:
    if current_user.is_authenticated:
        logout_user()
    return jsonify({"ok": True}), HTTPStatus.OK


@AUTH_BLUEPRINT.get("/session")
def session() -> Any:
    if current_user.is_authenticated:
        user = current_user  # type: ignore[assignment]
        return jsonify({"user": user.to_public_dict()})
    return jsonify({"user": None}), HTTPStatus.OK


def init_auth(app: Flask) -> None:
    """Initialise login manager, persistence, and blueprints."""

    db_path = Path(app.config["USER_DATABASE_PATH"])
    store = UserStore(db_path)
    app.extensions["transcoder_user_store"] = store

    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(user_id: str) -> Optional[User]:  # pragma: no cover - flask callback
        try:
            numeric = int(user_id)
        except (TypeError, ValueError):
            return None
        return store.get_by_id(numeric)

    @login_manager.unauthorized_handler
    def _unauthorized() -> Any:  # pragma: no cover - flask callback
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED

    app.register_blueprint(AUTH_BLUEPRINT)

    admin_username = os.getenv("TRANSCODER_ADMIN_USERNAME")
    admin_password = os.getenv("TRANSCODER_ADMIN_PASSWORD")
    admin_email = os.getenv("TRANSCODER_ADMIN_EMAIL")
    if admin_username and admin_password:
        admin = store.ensure_admin(admin_username.strip(), admin_password, admin_email)
        app.logger.info("Ensured admin account '%s' (id=%s)", admin.username, admin.id)
