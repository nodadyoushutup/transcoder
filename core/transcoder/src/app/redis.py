"""Redis utility helpers for infrastructure-level checks."""
from __future__ import annotations

from typing import Optional


def ensure_connection(url: Optional[str], *, label: str) -> None:
    """Validate that a Redis connection can be established for the given URL."""

    candidate = (url or "").strip()
    if not candidate:
        raise RuntimeError(f"{label} URL not configured.")
    try:  # pragma: no cover - optional dependency
        import redis  # type: ignore
    except Exception as exc:  # pragma: no cover - redis missing
        raise RuntimeError(
            f"redis package is required for {label.lower()} connections: {exc}"
        ) from exc

    client = None
    try:
        client = redis.from_url(
            candidate,
            socket_timeout=3,
            health_check_interval=30,
        )
        client.ping()
    except Exception as exc:  # pragma: no cover - network dependent
        raise RuntimeError(f"Unable to connect to {label} at {candidate}: {exc}") from exc
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:  # pragma: no cover - defensive
                pass


__all__ = ["ensure_connection"]

