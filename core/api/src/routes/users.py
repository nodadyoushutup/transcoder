"""User preference and profile management routes."""
from __future__ import annotations

import io
import os
import secrets
from typing import Any, Dict, Optional, Tuple

from PIL import Image
from flask import Blueprint, current_app, jsonify, request, send_file
from flask_login import current_user

from ..app.providers import db
from ..models import User
from ..services import SettingsService, UserService


USERS_BLUEPRINT = Blueprint("users", __name__, url_prefix="/users")

AVATAR_MAX_DIMENSION = 256
SUPPORTED_NOTIFY_SCOPE = {"all", "mentions", "none"}
SUPPORTED_THEMES = {"dark", "light", "monokai", "darcula"}
THEME_ALIASES = {
    "monaki": "monokai",
    "dracula": "darcula",
}


def _user_service() -> UserService:
    svc: UserService = current_app.extensions["user_service"]
    return svc


def _settings_service() -> SettingsService:
    svc: SettingsService = current_app.extensions["settings_service"]
    return svc


def _require_authentication() -> Tuple[Optional[User], Optional[Tuple[Any, int]]]:
    if not current_user.is_authenticated:
        return None, (jsonify({"error": "authentication required"}), 401)
    return current_user, None  # type: ignore[return-value]


def _user_avatar_dir() -> str:
    directory = current_app.config["AVATAR_UPLOAD_PATH"]
    os.makedirs(directory, exist_ok=True)
    return directory


def _remove_existing_avatar(user: User) -> None:
    if not user.avatar_path:
        return
    avatar_dir = _user_avatar_dir()
    existing_path = os.path.join(avatar_dir, user.avatar_path)
    if os.path.exists(existing_path):
        try:
            os.remove(existing_path)
        except OSError:
            current_app.logger.warning("Failed to remove avatar %s", existing_path)


@USERS_BLUEPRINT.get("/me/preferences")
def get_user_preferences() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    settings_service = _settings_service()
    chat_settings = settings_service.get_user_settings(user, SettingsService.USER_CHAT_NAMESPACE)
    system_defaults = settings_service.user_defaults(SettingsService.USER_CHAT_NAMESPACE)
    appearance_settings = settings_service.get_user_settings(
        user,
        SettingsService.USER_APPEARANCE_NAMESPACE,
    )
    appearance_defaults = settings_service.user_defaults(SettingsService.USER_APPEARANCE_NAMESPACE)
    payload = {
        "user": user.to_public_dict(),
        "chat": {
            "settings": chat_settings,
            "defaults": system_defaults,
        },
        "appearance": {
            "settings": appearance_settings,
            "defaults": appearance_defaults,
        },
    }
    return jsonify(payload)


@USERS_BLUEPRINT.patch("/me/profile")
def update_profile() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    username = payload.get("username")
    email = payload.get("email")
    try:
        updated = _user_service().update_profile(
            user,
            username=str(username).strip() if isinstance(username, str) else None,
            email=str(email).strip() if isinstance(email, str) else None,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"user": updated.to_public_dict()})


@USERS_BLUEPRINT.patch("/me/password")
def change_password() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    current_password = str(payload.get("current_password", ""))
    new_password = str(payload.get("new_password", ""))
    if not current_password or not new_password:
        return jsonify({"error": "current_password and new_password are required"}), 400
    if len(new_password) < 8:
        return jsonify({"error": "new_password must be at least 8 characters"}), 400
    try:
        _user_service().change_password(user, current_password, new_password)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True})


@USERS_BLUEPRINT.patch("/me/settings/chat")
def update_chat_preferences() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    settings_service = _settings_service()
    updates: Dict[str, Any] = {}

    if "notification_sound" in payload:
        sound = str(payload.get("notification_sound", "")).strip()
        if not sound:
            return jsonify({"error": "notification_sound cannot be blank"}), 400
        updates["notification_sound"] = sound

    if "notification_volume" in payload:
        try:
            volume = float(payload.get("notification_volume", 0.6))
        except (TypeError, ValueError):
            return jsonify({"error": "notification_volume must be a number"}), 400
        volume = min(1.0, max(0.0, volume))
        updates["notification_volume"] = volume

    if "notify_scope" in payload:
        scope = str(payload.get("notify_scope", "")).strip().lower()
        if scope not in SUPPORTED_NOTIFY_SCOPE:
            return jsonify({"error": "notify_scope is invalid"}), 400
        updates["notify_scope"] = scope

    for key, value in updates.items():
        settings_service.set_user_setting(user, SettingsService.USER_CHAT_NAMESPACE, key, value)

    chat_settings = settings_service.get_user_settings(user, SettingsService.USER_CHAT_NAMESPACE)
    return jsonify({"chat": chat_settings})


@USERS_BLUEPRINT.patch("/me/settings/appearance")
def update_appearance_preferences() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    if "theme" not in payload:
        return jsonify({"error": "theme is required"}), 400
    theme_value = str(payload.get("theme", "")).strip().lower()
    theme_value = THEME_ALIASES.get(theme_value, theme_value)
    if theme_value not in SUPPORTED_THEMES:
        return jsonify({"error": "theme is invalid"}), 400
    settings_service = _settings_service()
    settings_service.set_user_setting(
        user,
        SettingsService.USER_APPEARANCE_NAMESPACE,
        "theme",
        theme_value,
    )
    appearance_settings = settings_service.get_user_settings(
        user,
        SettingsService.USER_APPEARANCE_NAMESPACE,
    )
    return jsonify({"appearance": appearance_settings})


@USERS_BLUEPRINT.post("/me/avatar")
def upload_avatar() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    if "avatar" not in request.files:
        return jsonify({"error": "avatar file is required"}), 400
    file_storage = request.files["avatar"]
    if not file_storage or not file_storage.filename:
        return jsonify({"error": "avatar file is required"}), 400
    if file_storage.mimetype and not file_storage.mimetype.startswith("image/"):
        return jsonify({"error": "avatar must be an image"}), 400

    try:
        image = Image.open(file_storage.stream)
    except (OSError, ValueError) as exc:
        return jsonify({"error": f"invalid image: {exc}"}), 400

    image = image.convert("RGBA")
    max_side = max(image.size)
    if max_side > AVATAR_MAX_DIMENSION:
        scale = AVATAR_MAX_DIMENSION / max_side
        new_size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
        image = image.resize(new_size, Image.Resampling.LANCZOS)

    output = io.BytesIO()
    image.save(output, format="PNG")
    output.seek(0)

    avatar_dir = _user_avatar_dir()
    filename = f"user-{user.id}-{secrets.token_hex(8)}.png"
    target_path = os.path.join(avatar_dir, filename)

    with open(target_path, "wb") as file_out:
        file_out.write(output.read())

    _remove_existing_avatar(user)
    user.avatar_path = filename
    db.session.add(user)
    db.session.commit()

    return jsonify({"user": user.to_public_dict()})


@USERS_BLUEPRINT.delete("/me/avatar")
def delete_avatar() -> Any:
    user, error = _require_authentication()
    if error:
        return error
    _remove_existing_avatar(user)
    user.avatar_path = None
    db.session.add(user)
    db.session.commit()
    return jsonify({"user": user.to_public_dict()})


@USERS_BLUEPRINT.get("/<int:user_id>/avatar")
def get_avatar(user_id: int) -> Any:
    user = _user_service().get_by_id(user_id)
    if not user or not user.avatar_path:
        return jsonify({"error": "avatar not found"}), 404
    avatar_path = os.path.join(_user_avatar_dir(), user.avatar_path)
    if not os.path.exists(avatar_path):
        return jsonify({"error": "avatar not found"}), 404
    return send_file(avatar_path, mimetype="image/png")


__all__ = ["USERS_BLUEPRINT"]
