"""Redis-backed broadcaster for transcoder status updates."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

try:  # pragma: no cover - optional dependency
    import redis
    from redis import Redis
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover - redis not installed
    redis = None  # type: ignore[assignment]
    Redis = None  # type: ignore[assignment]
    RedisError = Exception  # type: ignore[assignment]

from .status_snapshot import TranscoderStatus

LOGGER = logging.getLogger(__name__)


class TranscoderStatusBroadcaster:
    """Publish controller status snapshots to Redis for downstream consumers."""

    def __init__(
        self,
        *,
        redis_url: Optional[str],
        prefix: str,
        namespace: str,
        key: str,
        channel: Optional[str],
        ttl_seconds: int,
    ) -> None:
        self._redis_url = redis_url or ""
        self._prefix = prefix.strip() or "transcoder"
        self._namespace = namespace.strip() or "transcoder"
        self._key = key.strip() or "status"
        self._channel = channel.strip() if isinstance(channel, str) else None
        self._ttl = max(0, int(ttl_seconds))
        self._client: Optional[Redis] = None
        self._last_error: Optional[str] = None
        self._connect()

    # ------------------------------------------------------------------
    # Lifecycle helpers
    # ------------------------------------------------------------------
    def _connect(self) -> None:
        if not self._redis_url:
            self._last_error = "Redis URL not configured"
            self._client = None
            return
        if redis is None:
            self._last_error = "redis package is not available"
            self._client = None
            LOGGER.warning("Redis package is not available; status broadcasting disabled")
            return

        previous = self._client
        try:
            client = redis.from_url(
                self._redis_url,
                socket_timeout=3,
                health_check_interval=30,
            )
            client.ping()
        except Exception as exc:  # pragma: no cover - network dependent
            LOGGER.warning("Failed to connect to Redis for status broadcasting: %s", exc)
            self._client = None
            self._last_error = f"Failed to connect to Redis: {exc}"
            return

        if previous is not None and previous is not client:
            try:
                previous.close()
            except Exception:  # pragma: no cover - defensive
                pass

        self._client = client
        self._last_error = None

    def _ensure_client(self) -> Optional[Redis]:
        client = self._client
        if client is not None:
            return client
        self._connect()
        return self._client

    def close(self) -> None:
        client = self._client
        if client is None:
            return
        try:
            client.close()
        except Exception:  # pragma: no cover - defensive
            pass
        self._client = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        return self._ensure_client() is not None

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    def publish(self, status: "TranscoderStatus") -> None:
        """Persist and broadcast the latest controller status."""

        client = self._ensure_client()
        if client is None:
            return
        payload = self._serialize(status)
        redis_key = self._redis_key()
        try:
            if self._ttl > 0:
                client.set(redis_key, payload, ex=self._ttl)
            else:
                client.set(redis_key, payload)
            self._last_error = None
        except RedisError as exc:  # pragma: no cover - network dependent
            self._last_error = f"Failed to write transcoder status: {exc}"
            LOGGER.debug("Failed to write transcoder status to Redis: %s", exc)
            try:
                client.close()
            except Exception:  # pragma: no cover - defensive
                pass
            self._client = None
            return

        if self._channel:
            try:
                client.publish(self._channel, payload)
            except RedisError as exc:  # pragma: no cover - network dependent
                self._last_error = f"Failed to publish transcoder status event: {exc}"
                LOGGER.debug("Failed to publish transcoder status event: %s", exc)
                try:
                    client.close()
                except Exception:  # pragma: no cover - defensive
                    pass
                self._client = None

    def clear(self) -> None:
        client = self._ensure_client()
        if client is None:
            return
        try:
            client.delete(self._redis_key())
        except RedisError:  # pragma: no cover - defensive
            LOGGER.debug("Failed to clear transcoder status key from Redis")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _redis_key(self) -> str:
        return f"{self._prefix}:{self._namespace}:{self._key}"

    @staticmethod
    def _serialize(status: "TranscoderStatus") -> str:
        session = status.to_session(
            origin="transcoder",
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        payload = {"session": session, "metadata": {}}
        try:
            serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):  # pragma: no cover - defensive
            fallback: Dict[str, Any] = {
                "session": {
                    "state": getattr(status, "state", "unknown"),
                    "running": getattr(status, "running", False),
                },
                "metadata": {},
            }
            serialized = json.dumps(fallback, ensure_ascii=False, separators=(",", ":"))
        return serialized


__all__ = ["TranscoderStatusBroadcaster"]
