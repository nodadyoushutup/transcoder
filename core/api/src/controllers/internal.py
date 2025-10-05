"""Internal service endpoints for configuration synchronization."""
from __future__ import annotations

import hmac
import logging
from typing import Any, Mapping

from flask import Blueprint, current_app, jsonify, request

from ..services import SettingsService

LOGGER = logging.getLogger(__name__)

INTERNAL_BLUEPRINT = Blueprint("internal", __name__, url_prefix="/internal")


def _settings_service() -> SettingsService:
    svc: SettingsService = current_app.extensions["settings_service"]
    return svc


def _expected_token() -> str | None:
    token = current_app.config.get("TRANSCODER_INTERNAL_TOKEN")
    if not isinstance(token, str):
        return None
    trimmed = token.strip()
    return trimmed or None


def _extract_token() -> str | None:
    auth_header = request.headers.get("Authorization")
    if isinstance(auth_header, str) and auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
        if candidate:
            return candidate
    header = request.headers.get("X-Internal-Token")
    if isinstance(header, str):
        candidate = header.strip()
        if candidate:
            return candidate
    return None


def _require_token() -> Any:
    expected = _expected_token()
    if not expected:
        LOGGER.warning(
            "Internal settings request blocked: TRANSCODER_INTERNAL_TOKEN not configured"
        )
        return jsonify({"error": "internal access not configured"}), 503

    provided = _extract_token()
    if not provided:
        return jsonify({"error": "missing token"}), 401

    if not hmac.compare_digest(provided, expected):
        LOGGER.warning("Internal settings request blocked: invalid token provided")
        return jsonify({"error": "invalid token"}), 403

    return None


def _merge(defaults: Mapping[str, Any], overrides: Mapping[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = dict(defaults)
    for key, value in overrides.items():
        merged[key] = value
    return merged


@INTERNAL_BLUEPRINT.get("/settings")
def fetch_settings() -> Any:
    """Return sanitized ingest and transcoder settings for internal consumers."""

    auth_error = _require_token()
    if auth_error:
        return auth_error

    settings_service = _settings_service()

    ingest_settings: dict[str, Any]
    ingest_defaults: dict[str, Any]
    try:
        ingest_settings = settings_service.get_sanitized_ingest_settings()
    except ValueError as exc:  # pragma: no cover - defensive validation
        LOGGER.warning("Failed to sanitize ingest settings from database: %s", exc)
        ingest_settings = {}
    try:
        ingest_defaults = settings_service.sanitize_ingest_settings(
            settings_service.system_defaults(SettingsService.INGEST_NAMESPACE)
        )
    except ValueError as exc:  # pragma: no cover - defensive validation
        LOGGER.warning("Failed to compute ingest defaults: %s", exc)
        ingest_defaults = {}

    transcoder_settings = settings_service.get_system_settings(
        SettingsService.TRANSCODER_NAMESPACE
    )
    transcoder_defaults = settings_service.system_defaults(
        SettingsService.TRANSCODER_NAMESPACE
    )
    transcoder_effective = _merge(transcoder_defaults, transcoder_settings)

    payload = {
        "ingest": {
            "settings": ingest_settings,
            "defaults": ingest_defaults,
        },
        "transcoder": {
            "settings": transcoder_settings,
            "defaults": transcoder_defaults,
            "effective": transcoder_effective,
        },
    }
    return jsonify(payload)


__all__ = ["INTERNAL_BLUEPRINT"]

