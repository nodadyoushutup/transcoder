"""Settings management routes for system and user administration."""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..models import Permission, User, UserGroup
from ..services import GroupService, PlexService, PlexServiceError, SettingsService, UserService
from ..transcoder.preview import compose_preview_command


SETTINGS_BLUEPRINT = Blueprint("settings", __name__, url_prefix="/settings")
logger = logging.getLogger(__name__)

NAMESPACE_PERMISSIONS: Dict[str, Tuple[str, ...]] = {
    SettingsService.TRANSCODER_NAMESPACE: ("transcoder.settings.manage", "system.settings.manage"),
    SettingsService.CHAT_NAMESPACE: ("chat.settings.manage", "system.settings.manage"),
    SettingsService.USERS_NAMESPACE: ("users.manage", "system.settings.manage"),
    SettingsService.PLEX_NAMESPACE: ("plex.settings.manage", "system.settings.manage"),
}


def _settings_service() -> SettingsService:
    svc: SettingsService = current_app.extensions["settings_service"]
    return svc


def _group_service() -> GroupService:
    svc: GroupService = current_app.extensions["group_service"]
    return svc


def _user_service() -> UserService:
    svc: UserService = current_app.extensions["user_service"]
    return svc


def _plex_service() -> PlexService:
    svc: PlexService = current_app.extensions["plex_service"]
    return svc


def _serialize_group(group: UserGroup) -> Dict[str, Any]:
    members = list(group.users or [])
    return {
        "id": int(group.id),
        "name": group.name,
        "slug": group.slug,
        "description": group.description or "",
        "is_system": bool(group.is_system),
        "permissions": sorted(permission.name for permission in group.permissions),
        "member_count": len(members),
    }


def _serialize_permission(permission: Permission) -> Dict[str, Any]:
    return {
        "id": int(permission.id),
        "name": permission.name,
        "description": permission.description or "",
    }


def _unauthorized() -> Tuple[Any, int]:
    return jsonify({"error": "authentication required"}), 401


def _forbidden() -> Tuple[Any, int]:
    return jsonify({"error": "forbidden"}), 403


def _require_permissions(permissions: Sequence[str]) -> Optional[Tuple[Any, int]]:
    if not current_user.is_authenticated:
        return _unauthorized()
    if getattr(current_user, "is_admin", False):
        return None
    checker = getattr(current_user, "has_permission", None)
    if callable(checker) and checker(permissions):
        return None
    return _forbidden()


@SETTINGS_BLUEPRINT.get("/system/<string:namespace>")
def get_system_settings(namespace: str) -> Any:
    normalized = namespace.strip().lower()
    perm_names = NAMESPACE_PERMISSIONS.get(normalized)
    if not perm_names:
        return jsonify({"error": "namespace not found"}), 404

    auth_error = _require_permissions(perm_names)
    if auth_error:
        return auth_error

    settings_service = _settings_service()
    group_service = _group_service()
    settings = settings_service.get_system_settings(normalized)
    if normalized == SettingsService.PLEX_NAMESPACE:
        has_token = bool(settings.get("auth_token"))
        settings = dict(settings)
        settings["auth_token"] = None
        settings["has_token"] = has_token
        for legacy_key in ("pin_id", "pin_code", "pin_expires_at"):
            settings.pop(legacy_key, None)
        if "verify_ssl" in settings:
            settings["verify_ssl"] = bool(settings["verify_ssl"])
        else:
            settings["verify_ssl"] = True
    defaults = settings_service.system_defaults(normalized)
    payload: Dict[str, Any] = {
        "namespace": normalized,
        "settings": settings,
        "defaults": defaults,
    }
    if normalized == SettingsService.TRANSCODER_NAMESPACE:
        try:
            preview = compose_preview_command(
                defaults=defaults,
                overrides=settings,
                app_config=current_app.config,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to compose transcoder preview: %s", exc)
        else:
            payload["simulated_command"] = preview.get("command")
            payload["simulated_command_argv"] = preview.get("argv")
    if normalized == SettingsService.USERS_NAMESPACE:
        groups = [_serialize_group(group) for group in group_service.list_groups()]
        permissions = [_serialize_permission(permission) for permission in group_service.list_permissions()]
        payload["groups"] = groups
        payload["permissions"] = permissions
    return jsonify(payload)


@SETTINGS_BLUEPRINT.put("/system/<string:namespace>")
def update_system_settings(namespace: str) -> Any:
    normalized = namespace.strip().lower()
    perm_names = NAMESPACE_PERMISSIONS.get(normalized)
    if not perm_names:
        return jsonify({"error": "namespace not found"}), 404

    auth_error = _require_permissions(perm_names)
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}
    values = payload.get("values") or {}
    if not isinstance(values, dict):
        return jsonify({"error": "values must be an object"}), 400

    settings_service = _settings_service()
    group_service = _group_service()
    defaults = settings_service.system_defaults(normalized)

    if normalized == SettingsService.PLEX_NAMESPACE:
        return jsonify({"error": "Plex settings are managed via dedicated endpoints."}), 400

    updated: Dict[str, Any] = {}
    for key, value in values.items():
        if normalized == SettingsService.USERS_NAMESPACE and key == "default_group":
            slug = str(value).strip().lower()
            group = group_service.get_group_by_slug(slug)
            if not group:
                return jsonify({"error": f"unknown group '{slug}'"}), 400
            updated_value = slug
        else:
            updated_value = value
        # Allow keys not present in defaults for forward compatibility
        settings_service.set_system_setting(normalized, key, updated_value, updated_by=current_user if isinstance(current_user, User) else None)
        updated[key] = updated_value

    final_settings = settings_service.get_system_settings(normalized)
    payload = {
        "namespace": normalized,
        "settings": final_settings,
        "defaults": defaults,
    }
    if normalized == SettingsService.TRANSCODER_NAMESPACE:
        try:
            preview = compose_preview_command(
                defaults=defaults,
                overrides=final_settings,
                app_config=current_app.config,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to compose transcoder preview after update: %s", exc)
        else:
            payload["simulated_command"] = preview.get("command")
            payload["simulated_command_argv"] = preview.get("argv")
    if normalized == SettingsService.USERS_NAMESPACE:
        payload["groups"] = [_serialize_group(group) for group in group_service.list_groups()]
    return jsonify(payload)


@SETTINGS_BLUEPRINT.post("/system/transcoder/preview")
def preview_transcoder_command() -> Any:
    normalized = SettingsService.TRANSCODER_NAMESPACE
    perm_names = NAMESPACE_PERMISSIONS.get(normalized)

    auth_error = _require_permissions(perm_names or tuple())
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}
    values = payload.get("values") or {}
    if not isinstance(values, dict):
        return jsonify({"error": "values must be an object"}), 400

    settings_service = _settings_service()
    defaults = settings_service.system_defaults(normalized)

    try:
        preview = compose_preview_command(
            defaults=defaults,
            overrides=values,
            app_config=current_app.config,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Failed to compose transcoder preview command")
        return jsonify({"error": "unable to compose command preview"}), 500

    return jsonify(preview)


@SETTINGS_BLUEPRINT.get("/groups")
def list_groups() -> Any:
    auth_error = _require_permissions(("users.manage", "system.settings.manage"))
    if auth_error:
        return auth_error
    group_service = _group_service()
    groups = [_serialize_group(group) for group in group_service.list_groups()]
    permissions = [_serialize_permission(permission) for permission in group_service.list_permissions()]
    return jsonify({"groups": groups, "permissions": permissions})


@SETTINGS_BLUEPRINT.post("/groups")
def create_group() -> Any:
    auth_error = _require_permissions(("users.manage",))
    if auth_error:
        return auth_error
    return jsonify({"error": "creating groups is disabled"}), 403


@SETTINGS_BLUEPRINT.patch("/groups/<int:group_id>")
def update_group(group_id: int) -> Any:
    auth_error = _require_permissions(("users.manage",))
    if auth_error:
        return auth_error
    group_service = _group_service()
    group = group_service.get_group_by_id(group_id)
    if not group:
        return jsonify({"error": "group not found"}), 404
    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    description = payload.get("description") if "description" in payload else None
    permissions = payload.get("permissions")
    if permissions is not None and not isinstance(permissions, Iterable):
        return jsonify({"error": "permissions must be a list"}), 400
    try:
        updated = group_service.update_group(
            group,
            name=str(name).strip() if isinstance(name, str) else None,
            description=str(description) if description is not None else None,
            permissions=[str(item) for item in permissions] if isinstance(permissions, Iterable) else None,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"group": _serialize_group(updated)})


@SETTINGS_BLUEPRINT.delete("/groups/<int:group_id>")
def delete_group(group_id: int) -> Any:
    auth_error = _require_permissions(("users.manage",))
    if auth_error:
        return auth_error
    group_service = _group_service()
    group = group_service.get_group_by_id(group_id)
    if not group:
        return jsonify({"error": "group not found"}), 404
    try:
        group_service.delete_group(group)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True})


@SETTINGS_BLUEPRINT.get("/users")
def list_users() -> Any:
    auth_error = _require_permissions(("users.manage",))
    if auth_error:
        return auth_error
    users = User.query.order_by(User.username.asc()).all()
    return jsonify({"users": [user.to_public_dict() for user in users]})


@SETTINGS_BLUEPRINT.patch("/users/<int:user_id>/groups")
def update_user_groups(user_id: int) -> Any:
    auth_error = _require_permissions(("users.manage",))
    if auth_error:
        return auth_error
    user_service = _user_service()
    group_service = _group_service()
    user = user_service.get_by_id(user_id)
    if not user:
        return jsonify({"error": "user not found"}), 404

    payload = request.get_json(silent=True) or {}
    groups_value = payload.get("groups")
    if not isinstance(groups_value, Iterable):
        return jsonify({"error": "groups must be a list"}), 400

    slugs: list[str] = []
    for value in groups_value:
        slug = str(value).strip().lower()
        if not slug:
            continue
        if slug == GroupService.ADMIN_SLUG and not user.is_admin:
            return jsonify({"error": "cannot assign admin group to non-admin user"}), 400
        if slug not in slugs:
            slugs.append(slug)

    if not slugs:
        slugs = [GroupService.USER_SLUG]

    for slug in slugs:
        if not group_service.get_group_by_slug(slug):
            return jsonify({"error": f"unknown group '{slug}'"}), 400

    if user.is_admin and GroupService.ADMIN_SLUG not in slugs:
        slugs.append(GroupService.ADMIN_SLUG)

    group_service.assign_user_to_groups(user, slugs, replace=True, commit=True)
    return jsonify({"user": user.to_public_dict()})


@SETTINGS_BLUEPRINT.post("/plex/connect")
def connect_plex() -> Any:
    perm_names = NAMESPACE_PERMISSIONS[SettingsService.PLEX_NAMESPACE]
    auth_error = _require_permissions(perm_names)
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}

    server_url_raw = (
        payload.get("server_url")
        or payload.get("server")
        or payload.get("host")
        or payload.get("base_url")
    )
    token_raw = payload.get("token") or payload.get("auth_token")
    verify_ssl_raw = payload.get("verify_ssl")

    if not isinstance(server_url_raw, str) or not server_url_raw.strip():
        return jsonify({"error": "server_url is required"}), 400
    if not isinstance(token_raw, str) or not token_raw.strip():
        return jsonify({"error": "token is required"}), 400

    verify_ssl: Optional[bool] = None
    if verify_ssl_raw is not None:
        if isinstance(verify_ssl_raw, bool):
            verify_ssl = verify_ssl_raw
        elif isinstance(verify_ssl_raw, str):
            lowered = verify_ssl_raw.strip().lower()
            if lowered in {"1", "true", "yes", "on"}:
                verify_ssl = True
            elif lowered in {"0", "false", "no", "off"}:
                verify_ssl = False
            else:
                return jsonify({"error": "verify_ssl must be a boolean"}), 400
        else:
            return jsonify({"error": "verify_ssl must be a boolean"}), 400

    plex_service = _plex_service()

    safe_url = str(server_url_raw).strip() if isinstance(server_url_raw, str) else ""
    display_url = safe_url or "<unknown>"
    verify_flag = verify_ssl if verify_ssl is not None else "auto"
    logger.info(
        "Plex direct connect attempt to %s (verify_ssl=%s)",
        display_url,
        verify_flag,
        extra={
            "event": "plex_connect_attempt",
            "server_url": safe_url,
            "verify_ssl": verify_ssl,
        },
    )

    try:
        result = plex_service.connect(
            server_url=server_url_raw,
            token=token_raw,
            verify_ssl=verify_ssl,
        )
    except PlexServiceError as exc:
        logger.warning(
            "Plex direct connect failed for %s: %s",
            display_url,
            exc,
            extra={
                "event": "plex_connect_failed",
                "server_url": safe_url,
                "verify_ssl": verify_ssl,
                "error": str(exc),
            },
        )
        return jsonify({"error": str(exc)}), 400

    snapshot = plex_service.get_account_snapshot()
    snapshot["has_token"] = True
    logger.info(
        "Plex direct connect succeeded for %s (verify_ssl=%s)",
        display_url,
        snapshot.get("verify_ssl"),
        extra={
            "event": "plex_connect_success",
            "server_url": safe_url,
            "verify_ssl": snapshot.get("verify_ssl"),
        },
    )
    return jsonify({"result": result, "settings": snapshot})


@SETTINGS_BLUEPRINT.post("/plex/disconnect")
def disconnect_plex() -> Any:
    perm_names = NAMESPACE_PERMISSIONS[SettingsService.PLEX_NAMESPACE]
    auth_error = _require_permissions(perm_names)
    if auth_error:
        return auth_error
    plex_service = _plex_service()
    result = plex_service.disconnect()
    return jsonify(result)


__all__ = ["SETTINGS_BLUEPRINT"]
