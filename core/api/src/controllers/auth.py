"""Authentication routes for the backend service."""
from __future__ import annotations

import os
from http import HTTPStatus
from typing import Any, Optional

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_user, logout_user

from ..extensions import db, login_manager
from ..models import User
from ..services.user_service import UserService

AUTH_BLUEPRINT = Blueprint("auth", __name__, url_prefix="/auth")


def _service() -> UserService:
    svc: UserService = current_app.extensions["user_service"]
    return svc


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
        user = _service().create_user(username=username, email=email, password=password)
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
    user = _service().verify(identifier, password)
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


def register_auth(app) -> None:
    """Initialise auth-related extensions and blueprints."""

    user_service = UserService()
    app.extensions["user_service"] = user_service

    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(user_id: str) -> Optional[User]:  # pragma: no cover - flask callback
        try:
            numeric = int(user_id)
        except (TypeError, ValueError):
            return None
        return user_service.get_by_id(numeric)

    @login_manager.unauthorized_handler
    def _unauthorized() -> Any:  # pragma: no cover - flask callback
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED

    app.register_blueprint(AUTH_BLUEPRINT)

    admin_username = os.getenv("TRANSCODER_ADMIN_USERNAME")
    admin_password = os.getenv("TRANSCODER_ADMIN_PASSWORD")
    admin_email = os.getenv("TRANSCODER_ADMIN_EMAIL")

    with app.app_context():
        db.create_all()
        if admin_username and admin_password:
            admin = user_service.ensure_admin(
                admin_username.strip(), admin_password, admin_email
            )
            app.logger.info("Ensured admin account '%s' (id=%s)", admin.username, admin.id)


__all__ = ["register_auth", "AUTH_BLUEPRINT"]
