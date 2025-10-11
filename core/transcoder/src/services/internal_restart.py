"""Helpers that encapsulate internal restart token validation."""
from __future__ import annotations

import hmac
import os
import signal
import threading
import time
from http import HTTPStatus
from typing import Optional

from flask import Flask, Request, jsonify

__all__ = ["RESTART_DELAY_SECONDS", "require_internal_token", "schedule_restart"]

RESTART_DELAY_SECONDS = 0.75


def require_internal_token(app: Flask, request: Request):
    """Validate the provided internal token, returning an error response if invalid."""

    expected = _expected_internal_token(app)
    if not expected:
        app.logger.warning("Internal restart blocked: token not configured")
        return jsonify({"error": "internal access not configured"}), HTTPStatus.SERVICE_UNAVAILABLE

    provided = _extract_internal_token(request)
    if not provided:
        return jsonify({"error": "missing token"}), HTTPStatus.UNAUTHORIZED

    if not hmac.compare_digest(provided, expected):
        app.logger.warning("Internal restart blocked: invalid token provided")
        return jsonify({"error": "invalid token"}), HTTPStatus.FORBIDDEN

    return None


def schedule_restart(app: Flask, *, delay_seconds: float = RESTART_DELAY_SECONDS) -> None:
    """Send SIGHUP (or SIGTERM fallback) to trigger a process restart."""

    logger = app.logger
    parent_pid = os.getppid()
    target_pid = parent_pid if parent_pid > 1 else os.getpid()

    def _worker(pid: int) -> None:
        time.sleep(delay_seconds)
        try:
            os.kill(pid, signal.SIGHUP)
            logger.info("Sent SIGHUP to pid %s to trigger restart", pid)
        except OSError as exc:
            logger.warning("Restart via SIGHUP failed for pid %s: %s", pid, exc)
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError as fallback_exc:
                logger.error("SIGTERM fallback failed for pid %s: %s", pid, fallback_exc)

    threading.Thread(target=_worker, args=(target_pid,), daemon=True).start()


# ----------------------------------------------------------------------
# Internal helpers
# ----------------------------------------------------------------------
def _expected_internal_token(app: Flask) -> Optional[str]:
    token = app.config.get("TRANSCODER_INTERNAL_TOKEN")
    if isinstance(token, str):
        trimmed = token.strip()
        if trimmed:
            return trimmed
    env_token = os.getenv("TRANSCODER_INTERNAL_TOKEN")
    if isinstance(env_token, str):
        trimmed = env_token.strip()
        if trimmed:
            return trimmed
    return None


def _extract_internal_token(request: Request) -> Optional[str]:
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
