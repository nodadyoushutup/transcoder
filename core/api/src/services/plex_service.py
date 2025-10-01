"""Helpers to integrate with Plex via OAuth and persist account metadata."""
from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from plexapi.exceptions import BadRequest
from plexapi.myplex import BASE_HEADERS, MyPlexAccount, MyPlexPinLogin

from .settings_service import SettingsService

logger = logging.getLogger(__name__)


class PlexServiceError(RuntimeError):
    """Raised when the Plex integration cannot complete an operation."""


@dataclass
class _ActivePin:
    """Tracks transient state for an in-flight OAuth PIN."""

    pin: MyPlexPinLogin
    created_at: datetime
    expires_at: datetime
    forward_url: Optional[str]

    def is_expired(self, now: datetime) -> bool:
        return now >= self.expires_at or bool(getattr(self.pin, "expired", False))


class PlexService:
    """Manage Plex OAuth flows and persist account credentials."""

    PIN_TTL = timedelta(minutes=10)

    def __init__(
        self,
        settings_service: SettingsService,
        *,
        client_identifier: Optional[str] = None,
        product: Optional[str] = None,
        device_name: Optional[str] = None,
        platform: Optional[str] = None,
        version: Optional[str] = None,
    ) -> None:
        self._settings = settings_service
        self._client_identifier = client_identifier or secrets.token_hex(12)
        self._product = product or "Publex"
        self._device_name = device_name or "Publex Admin"
        self._platform = platform or "Publex"
        self._version = version or "1.0"
        self._active_pins: Dict[str, _ActivePin] = {}

    # ------------------------------------------------------------------
    # Public API

    def start_oauth(self, *, forward_url: Optional[str] = None) -> Dict[str, Any]:
        """Initiate a Plex OAuth flow using the PIN login mechanism."""

        headers = self._build_headers()
        logger.info("Starting Plex OAuth flow with client identifier %s", headers["X-Plex-Client-Identifier"])
        try:
            pin = MyPlexPinLogin(headers=headers, oauth=True)
        except Exception as exc:  # pragma: no cover - network failures
            logger.exception("Unable to acquire Plex login PIN: %s", exc)
            raise PlexServiceError("Unable to start Plex OAuth flow.") from exc

        pin_id = getattr(pin, "_id", None)
        code = getattr(pin, "_code", None)
        if not pin_id or not code:
            raise PlexServiceError("Plex did not provide a valid PIN response.")

        now = datetime.now(timezone.utc)
        expires_at = now + self.PIN_TTL
        oauth_url = pin.oauthUrl(forward_url)
        self._active_pins[pin_id] = _ActivePin(pin=pin, created_at=now, expires_at=expires_at, forward_url=forward_url)

        self._update_settings({
            "status": "pending",
            "pin_id": pin_id,
            "pin_code": code,
            "pin_expires_at": expires_at.isoformat(),
        })

        return {
            "pin_id": pin_id,
            "code": code,
            "oauth_url": oauth_url,
            "expires_at": expires_at.isoformat(),
            "status": "pending",
        }

    def poll_oauth(self, pin_id: str) -> Dict[str, Any]:
        """Check whether the provided PIN has been authorized."""

        now = datetime.now(timezone.utc)
        entry = self._active_pins.get(pin_id)
        if not entry:
            # PIN may have been loaded before a process restart; treat as expired.
            settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
            stored_pin_id = settings.get("pin_id")
            if stored_pin_id == pin_id:
                self._clear_pin_state(status=settings.get("status") or "disconnected")
            raise PlexServiceError("Unknown or expired PIN identifier.")

        pin = entry.pin
        if entry.is_expired(now):
            logger.info("Plex OAuth PIN %s expired", pin_id)
            pin.stop()
            self._active_pins.pop(pin_id, None)
            self._clear_pin_state(status="expired")
            return {"status": "expired"}

        try:
            authorized = pin.checkLogin()
        except BadRequest as exc:  # pragma: no cover - depends on Plex API behaviour
            logger.warning("Plex returned error while checking PIN %s: %s", pin_id, exc)
            self._active_pins.pop(pin_id, None)
            self._clear_pin_state(status="error")
            raise PlexServiceError("Plex rejected the login attempt.") from exc
        except Exception as exc:  # pragma: no cover - network / unexpected errors
            logger.exception("Unexpected error while polling Plex for PIN %s: %s", pin_id, exc)
            self._active_pins.pop(pin_id, None)
            self._clear_pin_state(status="error")
            raise PlexServiceError("Unable to verify Plex login.") from exc

        if not authorized:
            return {"status": "pending"}

        token = pin.token
        if not token:
            return {"status": "pending"}

        logger.info("Plex OAuth PIN %s authorized; storing credentials", pin_id)
        self._active_pins.pop(pin_id, None)
        pin.stop()

        account_info = self._finalize_connection(token)
        return {"status": "connected", "account": account_info}

    def disconnect(self) -> Dict[str, Any]:
        """Remove any persisted Plex credentials."""

        logger.info("Disconnecting Plex account and clearing stored token")
        for key, entry in list(self._active_pins.items()):
            try:
                entry.pin.stop()
            except Exception:  # pragma: no cover - best-effort cleanup
                logger.debug("Ignoring error while stopping Plex PIN %s during disconnect", key)
            self._active_pins.pop(key, None)
        self._update_settings({
            "status": "disconnected",
            "auth_token": None,
            "account": None,
            "pin_id": None,
            "pin_code": None,
            "pin_expires_at": None,
        })
        return {"status": "disconnected"}

    def get_account_snapshot(self) -> Dict[str, Any]:
        """Return the stored account metadata without revealing the token."""

        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        account = settings.get("account") or None
        status = settings.get("status") or "disconnected"
        last_connected_at = settings.get("last_connected_at")
        has_token = bool(settings.get("auth_token"))
        return {
            "status": status,
            "account": account,
            "last_connected_at": last_connected_at,
            "has_token": has_token,
        }

    # ------------------------------------------------------------------
    # Internal helpers

    def _build_headers(self) -> Dict[str, Any]:
        headers = dict(BASE_HEADERS)
        headers["X-Plex-Client-Identifier"] = self._client_identifier
        headers["X-Plex-Product"] = self._product
        headers["X-Plex-Device"] = self._device_name
        headers["X-Plex-Device-Name"] = self._device_name
        headers["X-Plex-Platform"] = self._platform
        headers["X-Plex-Version"] = self._version
        headers.setdefault("X-Plex-Platform-Version", "1.0")
        return headers

    def _update_settings(self, values: Dict[str, Any]) -> None:
        for key, value in values.items():
            self._settings.set_system_setting(SettingsService.PLEX_NAMESPACE, key, value)

    def _clear_pin_state(self, *, status: Optional[str] = None) -> None:
        updates = {
            "pin_id": None,
            "pin_code": None,
            "pin_expires_at": None,
        }
        if status:
            updates["status"] = status
        self._update_settings(updates)

    def _finalize_connection(self, token: str) -> Dict[str, Any]:
        try:
            account = MyPlexAccount(token=token)
        except Exception as exc:  # pragma: no cover - network failures
            logger.exception("Unable to load Plex account details after OAuth: %s", exc)
            self._update_settings({
                "status": "error",
                "auth_token": None,
            })
            raise PlexServiceError("Authenticated with Plex but could not load account details.") from exc

        account_info = self._serialize_account(account)
        now = datetime.now(timezone.utc).isoformat()
        self._update_settings({
            "status": "connected",
            "auth_token": token,
            "account": account_info,
            "last_connected_at": now,
            "pin_id": None,
            "pin_code": None,
            "pin_expires_at": None,
        })
        return account_info

    @staticmethod
    def _serialize_account(account: MyPlexAccount) -> Dict[str, Any]:
        return {
            "id": getattr(account, "id", None),
            "uuid": getattr(account, "uuid", None),
            "username": getattr(account, "username", None),
            "email": getattr(account, "email", None),
            "title": getattr(account, "title", None),
            "thumb": getattr(account, "thumb", None),
            "friendly_name": getattr(account, "friendlyName", None),
            "subscription_active": getattr(account, "subscriptionActive", None),
            "subscription_plan": getattr(account, "subscriptionPlan", None),
            "subscription_status": getattr(account, "subscriptionStatus", None),
        }


__all__ = ["PlexService", "PlexServiceError"]
