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

logger = logging.getLogger(__name__)


class RedisService:
    """Expose a singleton Redis client with lightweight helpers."""

    DEFAULT_PREFIX = "transcoder"

    def __init__(
        self,
        *,
        redis_url: Optional[str],
        max_entries: int = 0,
        ttl_seconds: int = 0,
        prefix: Optional[str] = None,
        auto_connect: bool = True,
    ) -> None:
        self._prefix = (prefix or self.DEFAULT_PREFIX).strip() or self.DEFAULT_PREFIX
        self._lock = threading.RLock()
        self._client: Optional[Redis] = None
        self._redis_url = (redis_url or "").strip()
        self._max_entries = max(0, int(max_entries))
        self._ttl_seconds = max(0, int(ttl_seconds))
        self._last_error: Optional[str] = None
        self._local_locks: Dict[str, threading.Lock] = {}
        if auto_connect:
            self.reload()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def reload(
        self,
        *,
        redis_url: Optional[str] = None,
        max_entries: Optional[int] = None,
        ttl_seconds: Optional[int] = None,
    ) -> None:
        """Reconnect to Redis using the configured environment values."""

        if redis_url is not None:
            sanitized_url = str(redis_url or "").strip()
        else:
            sanitized_url = self._redis_url

        if max_entries is not None:
            try:
                sanitized_max = int(max_entries)
            except (TypeError, ValueError):
                sanitized_max = self._max_entries
            sanitized_max = max(0, sanitized_max)
        else:
            sanitized_max = self._max_entries

        if ttl_seconds is not None:
            try:
                sanitized_ttl = int(ttl_seconds)
            except (TypeError, ValueError):
                sanitized_ttl = self._ttl_seconds
            sanitized_ttl = max(0, sanitized_ttl)
        else:
            sanitized_ttl = self._ttl_seconds

        client: Optional[Redis] = None
        last_error: Optional[str] = None

        if sanitized_url:
            if redis is None:
                last_error = "redis package is not installed"
            else:
                try:
                    candidate = redis.from_url(  # type: ignore[arg-type]
                        sanitized_url,
                        socket_timeout=3,
                        health_check_interval=30,
                    )
                    candidate.ping()
                except Exception as exc:  # pragma: no cover - network dependent
                    last_error = f"Redis connection failed: {exc}"
                    candidate = None
                client = candidate
        else:
            last_error = "Redis URL not configured"

        with self._lock:
            previous = self._client
            self._client = client
            self._redis_url = sanitized_url
            self._max_entries = sanitized_max
            self._ttl_seconds = sanitized_ttl
            self._last_error = last_error

        if previous and previous is not client:
            try:
                previous.close()
            except Exception:  # pragma: no cover - defensive
                pass

        if last_error:
            logger.warning("Redis unavailable: %s", last_error)
        elif client:
            logger.info("Connected to Redis at %s", sanitized_url)

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
            return self._redis_url or None

    @property
    def ttl_seconds(self) -> int:
        with self._lock:
            return self._ttl_seconds

    @property
    def max_entries(self) -> int:
        with self._lock:
            return self._max_entries

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            snapshot = {
                "redis_url": self._redis_url,
                "max_entries": self._max_entries,
                "ttl_seconds": self._ttl_seconds,
                "backend": "redis" if self._client else "disabled",
                "available": self._client is not None,
                "managed_by": "environment",
            }
            if self._last_error:
                snapshot["last_error"] = self._last_error
        return snapshot

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
