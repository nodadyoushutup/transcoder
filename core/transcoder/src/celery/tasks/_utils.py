"""Shared helpers for Celery task modules."""
from __future__ import annotations

from typing import Any, Mapping

from ...services.transcode_session import get_runtime


def build_settings(app, overrides: Mapping[str, Any]):
    """Construct encoder settings using the shared runtime services."""

    runtime = get_runtime(app)
    return runtime.build_settings(overrides)


def status_payload(app) -> Mapping[str, Any]:
    """Return the latest status payload rendered for API responses."""

    runtime = get_runtime(app)
    return runtime.status_payload()


__all__ = ["build_settings", "status_payload"]
