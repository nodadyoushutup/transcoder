"""Settings management routes for system and user administration."""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from ..models import Permission, User, UserGroup
from ..services import (
    GroupService,
    PlexService,
    PlexServiceError,
    PlexNotConnectedError,
    SettingsService,
    TaskMonitorService,
    UserService,
)
from ..transcoder.preview import compose_preview_command


SETTINGS_BLUEPRINT = Blueprint("settings", __name__, url_prefix="/settings")
logger = logging.getLogger(__name__)

NAMESPACE_PERMISSIONS: Dict[str, Tuple[str, ...]] = {
    SettingsService.TRANSCODER_NAMESPACE: ("transcoder.settings.manage", "system.settings.manage"),
    SettingsService.CHAT_NAMESPACE: ("chat.settings.manage", "system.settings.manage"),
    SettingsService.USERS_NAMESPACE: ("users.manage", "system.settings.manage"),
    SettingsService.PLEX_NAMESPACE: ("plex.settings.manage", "system.settings.manage"),
    SettingsService.LIBRARY_NAMESPACE: ("library.settings.manage", "system.settings.manage"),
    SettingsService.REDIS_NAMESPACE: ("redis.settings.manage", "system.settings.manage"),
    SettingsService.TASKS_NAMESPACE: ("tasks.manage", "system.settings.manage"),
    SettingsService.INGEST_NAMESPACE: ("ingest.settings.manage", "system.settings.manage"),
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


def _task_monitor() -> Optional[TaskMonitorService]:
    monitor = current_app.extensions.get("task_monitor")
    if monitor is None:
        try:
            from ..celery_app import init_celery

            init_celery(current_app)
            monitor = current_app.extensions.get("task_monitor")
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("Unable to initialize task monitor: %s", exc)
            return None
    return monitor


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
    if normalized == SettingsService.REDIS_NAMESPACE:
        settings = settings_service.get_sanitized_redis_settings()
        defaults = settings_service.sanitize_redis_settings()
        payload: Dict[str, Any] = {
            "namespace": normalized,
            "settings": settings,
            "defaults": defaults,
        }
        redis_service = current_app.extensions.get("redis_service")
        if redis_service is not None:
            payload["redis_snapshot"] = redis_service.snapshot()
        return jsonify(payload)

    if normalized == SettingsService.INGEST_NAMESPACE:
        try:
            settings = settings_service.get_sanitized_ingest_settings()
            defaults = settings_service.sanitize_ingest_settings(
                settings_service.system_defaults(normalized)
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 500
        return jsonify({
            "namespace": normalized,
            "settings": settings,
            "defaults": defaults,
        })

    if normalized == SettingsService.TASKS_NAMESPACE:
        logger.info(
            "API request: fetch task settings (user=%s, remote=%s)",
            getattr(current_user, "id", None),
            request.remote_addr,
        )
        settings = settings_service.get_sanitized_tasks_settings()
        defaults = settings_service.sanitize_tasks_settings(
            settings_service.system_defaults(normalized),
        )
        payload = {
            "namespace": normalized,
            "settings": settings,
            "defaults": defaults,
        }
        monitor = _task_monitor()
        if monitor is not None:
            snapshot = monitor.snapshot()
            payload["snapshot"] = snapshot
            payload["snapshot_collected_at"] = snapshot.get("timestamp") if isinstance(snapshot, dict) else None
            payload["refresh_interval_seconds"] = monitor.refresh_interval_seconds()
        else:
            payload["snapshot_error"] = "Task monitor unavailable."
        return jsonify(payload)

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
    sections_payload: Dict[str, Any] | None = None
    if normalized == SettingsService.LIBRARY_NAMESPACE:
        defaults = settings_service.sanitize_library_settings()
        settings = settings_service.sanitize_library_settings(settings)
        plex_service = _plex_service()
        try:
            sections_payload = plex_service.list_sections()
        except PlexNotConnectedError as exc:
            sections_payload = {"sections": [], "error": str(exc)}
        except PlexServiceError as exc:
            sections_payload = {"sections": [], "error": str(exc)}
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to gather Plex sections for library settings: %s", exc)
            sections_payload = {"sections": [], "error": "Unable to load Plex sections."}
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
    if normalized == SettingsService.LIBRARY_NAMESPACE and sections_payload is not None:
        payload["sections"] = sections_payload.get("sections", [])
        payload["server"] = sections_payload.get("server")
        if sections_payload.get("error"):
            payload["sections_error"] = sections_payload.get("error")
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
    if normalized == SettingsService.LIBRARY_NAMESPACE:
        defaults = settings_service.sanitize_library_settings()

    if normalized == SettingsService.PLEX_NAMESPACE:
        return jsonify({"error": "Plex settings are managed via dedicated endpoints."}), 400

    if normalized == SettingsService.REDIS_NAMESPACE:
        sanitized_input = settings_service.sanitize_redis_settings(values)
        current_settings = settings_service.get_sanitized_redis_settings()
        diff: Dict[str, Any] = {}
        for key in ("redis_url", "max_entries", "ttl_seconds"):
            candidate = sanitized_input.get(key)
            if candidate != current_settings.get(key):
                diff[key] = candidate
        if not diff:
            final_settings = current_settings
        else:
            for key, value in diff.items():
                settings_service.set_system_setting(
                    normalized,
                    key,
                    value,
                    updated_by=current_user if isinstance(current_user, User) else None,
                )
            final_settings = settings_service.get_sanitized_redis_settings()
            redis_service = current_app.extensions.get("redis_service")
            if redis_service is not None:
                reload_fn = getattr(redis_service, "reload", None)
                if callable(reload_fn):
                    reload_fn()
        payload = {
            "namespace": normalized,
            "settings": final_settings,
            "defaults": settings_service.sanitize_redis_settings(),
        }
        redis_service = current_app.extensions.get("redis_service")
        if redis_service is not None:
            payload["redis_snapshot"] = redis_service.snapshot()
        return jsonify(payload)

    if normalized == SettingsService.INGEST_NAMESPACE:
        try:
            sanitized_input = settings_service.sanitize_ingest_settings(values)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        current_settings = settings_service.get_sanitized_ingest_settings()
        if sanitized_input == current_settings:
            final_settings = current_settings
        else:
            for key, value in sanitized_input.items():
                settings_service.set_system_setting(
                    normalized,
                    key,
                    value,
                    updated_by=current_user if isinstance(current_user, User) else None,
                )
            final_settings = settings_service.get_sanitized_ingest_settings()
        try:
            defaults = settings_service.sanitize_ingest_settings(
                settings_service.system_defaults(normalized)
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 500
        payload = {
            "namespace": normalized,
            "settings": final_settings,
            "defaults": defaults,
        }
        return jsonify(payload)

    if normalized == SettingsService.TASKS_NAMESPACE:
        monitor = _task_monitor()
        updated_by = current_user if isinstance(current_user, User) else None
        if monitor is not None:
            sanitized = monitor.update_schedule(values, updated_by=updated_by)
            snapshot = monitor.snapshot()
            refresh_interval = monitor.refresh_interval_seconds()
        else:
            sanitized = settings_service.set_tasks_settings(values, updated_by=updated_by)
            snapshot = None
            refresh_interval = sanitized.get("refresh_interval_seconds")
        defaults = settings_service.sanitize_tasks_settings(
            settings_service.system_defaults(normalized),
        )
        payload = {
            "namespace": normalized,
            "settings": sanitized,
            "defaults": defaults,
            "refresh_interval_seconds": refresh_interval,
        }
        if snapshot is not None:
            payload["snapshot"] = snapshot
        return jsonify(payload)

    updated: Dict[str, Any] = {}
    for key, value in values.items():
        if normalized == SettingsService.USERS_NAMESPACE and key == "default_group":
            slug = str(value).strip().lower()
            group = group_service.get_group_by_slug(slug)
            if not group:
                return jsonify({"error": f"unknown group '{slug}'"}), 400
            updated_value = slug
        elif normalized == SettingsService.LIBRARY_NAMESPACE and key == "hidden_sections":
            if not isinstance(value, (list, tuple, set)):
                return jsonify({"error": "hidden_sections must be an array."}), 400
            updated_value = SettingsService._normalize_library_hidden_sections(value)
        elif normalized == SettingsService.LIBRARY_NAMESPACE and key == "section_page_size":
            updated_value = SettingsService._normalize_library_page_size(value, defaults.get("section_page_size"))
        elif normalized == SettingsService.LIBRARY_NAMESPACE and key == "default_section_view":
            updated_value = SettingsService._normalize_library_section_view(
                value,
                defaults.get("default_section_view"),
            )
        elif normalized == SettingsService.TRANSCODER_NAMESPACE and key == "TRANSCODER_LOCAL_OUTPUT_DIR":
            try:
                updated_value = settings_service._normalize_absolute_path(value)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
        else:
            updated_value = value
        # Allow keys not present in defaults for forward compatibility
        settings_service.set_system_setting(normalized, key, updated_value, updated_by=current_user if isinstance(current_user, User) else None)
        updated[key] = updated_value

    final_settings = settings_service.get_system_settings(normalized)
    if normalized == SettingsService.LIBRARY_NAMESPACE:
        final_settings = settings_service.sanitize_library_settings(final_settings)
        redis_service = current_app.extensions.get("redis_service")
        if redis_service is not None:
            clear_namespace = getattr(redis_service, "clear_namespace", None)
            if callable(clear_namespace):
                clear_namespace(PlexService.SECTION_CACHE_NAMESPACE)
                clear_namespace(PlexService.SECTION_ITEMS_CACHE_NAMESPACE)
        try:
            from ..tasks.library import enqueue_sections_snapshot_refresh

            if not enqueue_sections_snapshot_refresh(force_refresh=True):
                logger.warning("Plex sections snapshot refresh could not be enqueued")
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to schedule Plex sections snapshot refresh: %s", exc)
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
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
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
    try:
        from ..tasks.library import enqueue_sections_snapshot_refresh

        if not enqueue_sections_snapshot_refresh(force_refresh=True):
            logger.warning("Plex sections snapshot refresh could not be enqueued after connect")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to schedule Plex sections snapshot refresh after connect: %s", exc)
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


@SETTINGS_BLUEPRINT.post("/tasks/stop")
def stop_task() -> Any:
    auth_error = _require_permissions(("tasks.manage", "system.settings.manage"))
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}
    raw_identifier = payload.get("task_id") or payload.get("id")
    if isinstance(raw_identifier, str):
        task_id = raw_identifier.strip()
    elif raw_identifier is not None:
        task_id = str(raw_identifier).strip()
    else:
        task_id = ""
    if not task_id:
        return jsonify({"error": "task_id is required"}), 400

    terminate = bool(payload.get("terminate"))
    monitor = _task_monitor()
    if monitor is None:
        return jsonify({"error": "Task monitor unavailable."}), 503

    success = monitor.stop_task(task_id, terminate=terminate)
    if not success:
        return jsonify({"error": "Unable to stop Celery task."}), 502

    snapshot = monitor.snapshot()
    return jsonify(
        {
            "stopped": True,
            "task_id": task_id,
            "terminate": terminate,
            "snapshot": snapshot,
        }
    )


__all__ = ["SETTINGS_BLUEPRINT"]
