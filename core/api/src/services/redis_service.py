"""Redis coordination helpers for caching and distributed state."""
from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional

try:  # pragma: no cover - optional dependency
    import redis
    from redis import Redis
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover - redis not installed
    redis = None
    Redis = None  # type: ignore[assignment]
    RedisError = Exception  # type: ignore[assignment]

from .settings_service import SettingsService

logger = logging.getLogger(__name__)


class RedisService:
    """Expose a singleton Redis client with lightweight helpers."""

    DEFAULT_PREFIX = "publex"

    def __init__(
        self,
        settings_service: SettingsService,
        *,
        prefix: Optional[str] = None,
        auto_reload: bool = True,
    ) -> None:
        self._settings = settings_service
        self._prefix = prefix or self.DEFAULT_PREFIX
        self._lock = threading.RLock()
        self._client: Optional[Redis] = None
        self._config: Dict[str, Any] = {}
        self._last_error: Optional[str] = None
        self._local_locks: Dict[str, threading.Lock] = {}
        if auto_reload:
            self.reload()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def reload(self) -> None:
        """Refresh the Redis configuration and reconnect if possible."""

        raw = self._settings.get_system_settings(SettingsService.REDIS_NAMESPACE)
        sanitized = self._settings.sanitize_redis_settings(raw)
        redis_url = str(sanitized.get("redis_url") or "").strip()
        max_entries = int(sanitized.get("max_entries") or 0)
        ttl_seconds = int(sanitized.get("ttl_seconds") or 0)

        client: Optional[Redis] = None
        last_error: Optional[str] = None

        if redis_url:
            if redis is None:
                last_error = "redis package is not installed"
            else:
                try:
                    client = redis.from_url(redis_url, socket_timeout=3, health_check_interval=30)  # type: ignore[arg-type]
                    client.ping()
                except Exception as exc:  # pragma: no cover - network dependent
                    last_error = f"Redis connection failed: {exc}"
                    client = None
        else:
            last_error = "Redis URL not configured"

        with self._lock:
            previous = self._client
            self._client = client
            self._config = {
                "redis_url": redis_url,
                "max_entries": max_entries,
                "ttl_seconds": ttl_seconds,
                "backend": "redis" if client else "disabled",
            }
            self._last_error = last_error

        if previous and previous is not client:
            try:
                previous.close()
            except Exception:  # pragma: no cover - defensive
                pass

        if last_error:
            logger.warning("Redis unavailable: %s", last_error)
        elif client:
            logger.info("Connected to Redis at %s", redis_url)

    # ------------------------------------------------------------------
    # Introspection helpers
    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        with self._lock:
            return self._client is not None

    @property
    def redis_url(self) -> Optional[str]:
        with self._lock:
            return self._config.get("redis_url") or None

    @property
    def ttl_seconds(self) -> int:
        with self._lock:
            return int(self._config.get("ttl_seconds") or 0)

    @property
    def max_entries(self) -> int:
        with self._lock:
            return int(self._config.get("max_entries") or 0)

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            payload = dict(self._config)
            payload["available"] = self._client is not None
            if self._last_error:
                payload["last_error"] = self._last_error
        return payload

    def message_queue_url(self) -> Optional[str]:
        return self.redis_url if self.available else None

    # ------------------------------------------------------------------
    # Cache primitives
    # ------------------------------------------------------------------
    def cache_get(self, namespace: str, key: str) -> Optional[Dict[str, Any]]:
        client = self._client
        if not client:
            return None
        redis_key = self._cache_key(namespace, key)
        try:
            payload = client.get(redis_key)
        except RedisError as exc:  # pragma: no cover - network dependent
            logger.debug("Redis GET failed for %s: %s", redis_key, exc)
            return None
        if payload is None:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError:  # pragma: no cover - defensive
            logger.debug("Failed to decode cached payload for %s", redis_key)
            return None

    def cache_set(self, namespace: str, key: str, value: Dict[str, Any]) -> None:
        client = self._client
        if not client:
            return
        try:
            payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):  # pragma: no cover - defensive
            logger.debug("Unable to serialize cache payload for %s:%s", namespace, key)
            return

        redis_key = self._cache_key(namespace, key)
        ttl = self.ttl_seconds
        try:
            if ttl > 0:
                client.set(redis_key, payload, ex=ttl)
            else:
                client.set(redis_key, payload)
            self._record_index(namespace, redis_key)
        except RedisError as exc:  # pragma: no cover - network dependent
            logger.debug("Redis SET failed for %s: %s", redis_key, exc)

    def cache_delete(self, namespace: str, key: str) -> None:
        client = self._client
        if not client:
            return
        redis_key = self._cache_key(namespace, key)
        try:
            pipe = client.pipeline()
            pipe.delete(redis_key)
            pipe.zrem(self._index_key(namespace), redis_key)
            pipe.execute()
        except RedisError:  # pragma: no cover - defensive
            return

    def clear_namespace(self, namespace: str) -> None:
        client = self._client
        if not client:
            return
        index_key = self._index_key(namespace)
        try:
            keys = list(client.zrange(index_key, 0, -1))
            if keys:
                client.delete(*keys)
            client.delete(index_key)
        except RedisError:  # pragma: no cover - defensive
            logger.debug("Failed to clear Redis namespace %s", namespace)

    # ------------------------------------------------------------------
    # JSON helpers
    # ------------------------------------------------------------------
    def json_get(self, namespace: str, key: str) -> Optional[Dict[str, Any]]:
        return self.cache_get(namespace, key)

    def json_set(
        self,
        namespace: str,
        key: str,
        value: Dict[str, Any],
        *,
        ttl: Optional[int] = None,
    ) -> None:
        client = self._client
        if not client:
            return
        try:
            payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):  # pragma: no cover - defensive
            logger.debug("Unable to serialize JSON payload for %s:%s", namespace, key)
            return
        redis_key = self._cache_key(namespace, key)
        expiration = ttl if (ttl is not None and ttl > 0) else self.ttl_seconds
        try:
            if expiration > 0:
                client.set(redis_key, payload, ex=expiration)
            else:
                client.set(redis_key, payload)
        except RedisError as exc:  # pragma: no cover - network dependent
            logger.debug("Redis SET JSON failed for %s: %s", redis_key, exc)

    def delete(self, namespace: str, key: str) -> None:
        client = self._client
        if not client:
            return
        redis_key = self._cache_key(namespace, key)
        try:
            client.delete(redis_key)
        except RedisError:  # pragma: no cover - defensive
            return

    # ------------------------------------------------------------------
    # Locking
    # ------------------------------------------------------------------
    @contextmanager
    def lock(
        self,
        name: str,
        *,
        timeout: int = 30,
        blocking_timeout: Optional[int] = 30,
    ) -> Iterator[None]:
        client = self._client
        if client is None:
            local_lock = self._get_local_lock(name)
            local_lock.acquire()
            try:
                yield
            finally:
                local_lock.release()
            return

        redis_lock = client.lock(
            f"{self._prefix}:lock:{name}",
            timeout=timeout,
            blocking_timeout=blocking_timeout,
        )
        acquired = False
        try:
            acquired = redis_lock.acquire(blocking=blocking_timeout is not None)
        except RedisError as exc:  # pragma: no cover - defensive
            logger.warning("Failed to acquire Redis lock %s: %s", name, exc)
        if not acquired:
            raise TimeoutError(f"Unable to acquire Redis lock '{name}'")
        try:
            yield
        finally:
            try:
                redis_lock.release()
            except RedisError:  # pragma: no cover - defensive
                pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _cache_key(self, namespace: str, key: str) -> str:
        return f"{self._prefix}:{namespace}:{key}"

    def _index_key(self, namespace: str) -> str:
        return f"{self._prefix}:{namespace}:__index__"

    def _record_index(self, namespace: str, redis_key: str) -> None:
        client = self._client
        if not client:
            return
        max_entries = self.max_entries
        timestamp = time.time()
        index_key = self._index_key(namespace)
        try:
            pipe = client.pipeline()
            pipe.zadd(index_key, {redis_key: timestamp})
            if max_entries > 0:
                pipe.zcard(index_key)
            result = pipe.execute()
            if max_entries > 0 and result and isinstance(result[-1], (int, float)):
                count = int(result[-1])
                if count > max_entries:
                    excess = count - max_entries
                    stale_keys = client.zrange(index_key, 0, excess - 1)
                    if stale_keys:
                        pipe = client.pipeline()
                        pipe.zrem(index_key, *stale_keys)
                        pipe.delete(*stale_keys)
                        pipe.execute()
        except RedisError:  # pragma: no cover - defensive
            logger.debug("Failed to update Redis index for namespace %s", namespace)

    def _get_local_lock(self, name: str) -> threading.Lock:
        with self._lock:
            lock = self._local_locks.get(name)
            if lock is None:
                lock = threading.Lock()
                self._local_locks[name] = lock
            return lock


__all__ = ["RedisService"]

