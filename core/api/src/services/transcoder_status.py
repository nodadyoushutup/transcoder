"""Helpers for retrieving and broadcasting transcoder status."""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from typing import Any, Callable, Dict, MutableMapping, Optional, Tuple

try:  # pragma: no cover - optional dependency
    import redis
    from redis import Redis
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover - redis not installed
    redis = None  # type: ignore[assignment]
    Redis = None  # type: ignore[assignment]
    RedisError = Exception  # type: ignore[assignment]

from flask_socketio import SocketIO

from .redis_service import RedisService
from .transcoder_client import TranscoderClient

LOGGER = logging.getLogger(__name__)


class TranscoderStatusService:
    """Prefer Redis-backed status snapshots with HTTP fallback."""

    def __init__(
        self,
        *,
        client: TranscoderClient,
        redis_service: RedisService,
        namespace: str,
        key: str,
        stale_after_seconds: int,
    ) -> None:
        self._client = client
        self._redis = redis_service
        self._namespace = namespace
        self._key = key
        self._stale_after = max(1, int(stale_after_seconds))

    def status(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        cached = self._read_redis()
        if cached is not None:
            session = cached.get("session") if isinstance(cached.get("session"), MutableMapping) else None
            if session is not None:
                session.setdefault("origin", "redis")
            else:  # pragma: no cover - legacy defensive path
                cached["session"] = {"origin": "redis"}
            return HTTPStatus.OK, cached
        return self._client.status()

    def _read_redis(self) -> Optional[MutableMapping[str, Any]]:
        if not self._redis.available:
            return None
        payload = self._redis.json_get(self._namespace, self._key)
        if not isinstance(payload, dict):
            return None
        payload_dict: Dict[str, Any] = dict(payload)
        updated_at = payload_dict.get("updated_at")
        if not isinstance(updated_at, str):
            session_section = payload_dict.get("session")
            if isinstance(session_section, MutableMapping):
                session_updated = session_section.get("updated_at")
                if isinstance(session_updated, str):
                    updated_at = session_updated
                    payload_dict["updated_at"] = updated_at
        if not isinstance(updated_at, str):
            LOGGER.debug("Transcoder status missing updated_at; ignoring cached snapshot")
            return None
        try:
            updated = datetime.fromisoformat(updated_at)
        except ValueError:
            LOGGER.debug("Transcoder status has invalid updated_at %r", updated_at)
            return None
        now = datetime.now(timezone.utc)
        delta = (now - updated).total_seconds()
        if delta > self._stale_after:
            LOGGER.debug(
                "Transcoder status stale (age=%.2fs > %ss)",
                delta,
                self._stale_after,
            )
            return None
        # Ensure JSON numbers remain JSON-serializable by returning a shallow copy.
        return payload_dict


class TranscoderStatusSubscriber:
    """Relay Redis pub/sub status updates to connected Socket.IO clients."""

    def __init__(
        self,
        *,
        redis_url: Optional[str],
        channel: Optional[str],
        socketio: SocketIO,
        status_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self._redis_url = (redis_url or "").strip()
        self._channel = channel.strip() if isinstance(channel, str) else None
        self._socketio = socketio
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._pubsub = None
        self._logger = LOGGER.getChild("subscriber")
        self._callback = status_callback

    def start(self) -> None:
        if not self._redis_url or not self._channel:
            return
        if self._thread and self._thread.is_alive():
            return
        if redis is None:
            self._logger.warning("Redis package not available; cannot subscribe to status channel")
            return
        self._stop.clear()
        thread = threading.Thread(target=self._run, name="transcoder-status-subscriber", daemon=True)
        self._thread = thread
        thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._pubsub is not None:
            try:
                self._pubsub.close()
            except Exception:  # pragma: no cover - defensive
                pass
            self._pubsub = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        self._stop.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _run(self) -> None:
        client: Optional[Redis] = None
        try:
            client = redis.from_url(
                self._redis_url,
                socket_timeout=3,
                health_check_interval=30,
            )
            pubsub = client.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe(self._channel)
            self._pubsub = pubsub
            self._logger.debug("Subscribed to %s for transcoder status events", self._channel)
            while not self._stop.is_set():
                message = pubsub.get_message(timeout=1.0)
                if not message:
                    continue
                if message.get("type") != "message":
                    continue
                data = message.get("data")
                if isinstance(data, bytes):
                    data = data.decode("utf-8", errors="replace")
                if not data:
                    continue
                payload = self._parse_payload(data)
                if payload is None:
                    continue
                payload.setdefault("source", payload.get("origin", "redis"))
                self._socketio.emit("transcoder:status", payload)
                if self._callback is not None:
                    try:
                        LOGGER.info(
                            "TranscoderStatusSubscriber forwarding payload (running=%s session=%s)",
                            payload.get("session", {}).get("running"),
                            payload.get("session", {}).get("id")
                            or payload.get("session", {}).get("session_id")
                            or payload.get("session", {}).get("sessionId"),
                        )
                        self._callback(payload)
                    except Exception:  # pragma: no cover - defensive
                        self._logger.debug("Status callback raised an exception", exc_info=True)
        except Exception as exc:  # pragma: no cover - network dependent
            if not self._stop.is_set():
                self._logger.warning("Transcoder status subscriber stopped unexpectedly: %s", exc)
        finally:
            if self._pubsub is not None:
                try:
                    self._pubsub.close()
                except Exception:  # pragma: no cover - defensive
                    pass
                self._pubsub = None
            if client is not None:
                try:
                    client.close()
                except Exception:  # pragma: no cover - defensive
                    pass

    @staticmethod
    def _parse_payload(raw: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, str):
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            LOGGER.debug("Discarded invalid transcoder status payload: %r", raw)
            return None
        if not isinstance(payload, dict):
            return None
        return payload


__all__ = ["TranscoderStatusService", "TranscoderStatusSubscriber"]
