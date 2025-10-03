"""Shared caching helpers for Plex metadata and library responses."""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Iterable, Optional

try:  # pragma: no cover - optional dependency
    import redis
    from redis import Redis
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover - redis not installed
    redis = None
    Redis = None  # type: ignore
    RedisError = Exception  # type: ignore

from .settings_service import SettingsService

logger = logging.getLogger(__name__)


class _CacheBackend:
    """Minimal interface for cache backends."""

    def get(self, namespace: str, key: str) -> Optional[str]:  # pragma: no cover - interface
        raise NotImplementedError

    def set(self, namespace: str, key: str, value: str, ttl: Optional[int]) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def delete(self, namespace: str, key: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def clear_namespace(self, namespace: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def clear_all(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class _MemoryCacheBackend(_CacheBackend):
    """Simple in-process LRU cache with optional TTL support."""

    def __init__(self, *, max_entries: int) -> None:
        self._max_entries = max_entries if isinstance(max_entries, int) and max_entries > 0 else None
        self._data: Dict[str, OrderedDict[str, tuple[Optional[float], str]]] = {}
        self._lock = threading.RLock()
        self._last_error: Optional[str] = None

    def get(self, namespace: str, key: str) -> Optional[str]:
        with self._lock:
            bucket = self._data.get(namespace)
            if not bucket:
                return None
            entry = bucket.get(key)
            if not entry:
                return None
            expires_at, payload = entry
            if expires_at is not None and expires_at <= time.time():
                bucket.pop(key, None)
                return None
            bucket.move_to_end(key)
            return payload

    def set(self, namespace: str, key: str, value: str, ttl: Optional[int]) -> None:
        expires_at = time.time() + ttl if isinstance(ttl, int) and ttl > 0 else None
        with self._lock:
            bucket = self._data.setdefault(namespace, OrderedDict())
            bucket[key] = (expires_at, value)
            bucket.move_to_end(key)
            if self._max_entries is not None and len(bucket) > self._max_entries:
                bucket.popitem(last=False)

    def delete(self, namespace: str, key: str) -> None:
        with self._lock:
            bucket = self._data.get(namespace)
            if not bucket:
                return
            bucket.pop(key, None)

    def clear_namespace(self, namespace: str) -> None:
        with self._lock:
            self._data.pop(namespace, None)

    def clear_all(self) -> None:
        with self._lock:
            self._data.clear()

    def close(self) -> None:  # pragma: no cover - nothing to release
        return


class _RedisCacheBackend(_CacheBackend):
    """Redis-backed cache with LRU-style trimming per namespace."""

    def __init__(self, *, url: str, max_entries: int, prefix: str) -> None:
        if redis is None:  # pragma: no cover - optional dependency
            raise RuntimeError("redis package is not available")
        self._client: Redis = redis.from_url(url, socket_timeout=3, health_check_interval=30)  # type: ignore[arg-type]
        self._max_entries = max_entries if isinstance(max_entries, int) and max_entries > 0 else None
        self._prefix = prefix.strip() or "cache"
        self._lock = threading.RLock()

    def _data_key(self, namespace: str, key: str) -> str:
        return f"{self._prefix}:{namespace}:{key}"

    def _index_key(self, namespace: str) -> str:
        return f"{self._prefix}:{namespace}:__index__"

    def get(self, namespace: str, key: str) -> Optional[str]:
        data_key = self._data_key(namespace, key)
        try:
            payload = self._client.get(data_key)
        except RedisError as exc:  # pragma: no cover - depends on redis availability
            logger.warning("Redis cache get failed for %s: %s", data_key, exc)
            return None
        if payload is None:
            return None
        return payload.decode("utf-8") if isinstance(payload, bytes) else str(payload)

    def set(self, namespace: str, key: str, value: str, ttl: Optional[int]) -> None:
        data_key = self._data_key(namespace, key)
        index_key = self._index_key(namespace)
        timestamp = time.time()
        try:
            pipe = self._client.pipeline()
            if isinstance(ttl, int) and ttl > 0:
                pipe.set(data_key, value, ex=ttl)
            else:
                pipe.set(data_key, value)
            pipe.zadd(index_key, {data_key: timestamp})
            if self._max_entries is not None:
                pipe.zcard(index_key)
            results = pipe.execute()
            if self._max_entries is None:
                return
            count = results[-1] if results else 0
            if isinstance(count, (int, float)) and count > self._max_entries:
                excess = int(count - self._max_entries)
                if excess <= 0:
                    return
                stale_keys = self._client.zrange(index_key, 0, excess - 1)
                if stale_keys:
                    pipe = self._client.pipeline()
                    pipe.zrem(index_key, *stale_keys)
                    pipe.delete(*stale_keys)
                    pipe.execute()
        except RedisError as exc:  # pragma: no cover - depends on redis availability
            logger.warning("Redis cache set failed for %s: %s", data_key, exc)

    def delete(self, namespace: str, key: str) -> None:
        data_key = self._data_key(namespace, key)
        index_key = self._index_key(namespace)
        try:
            pipe = self._client.pipeline()
            pipe.delete(data_key)
            pipe.zrem(index_key, data_key)
            pipe.execute()
        except RedisError as exc:  # pragma: no cover - depends on redis availability
            logger.warning("Redis cache delete failed for %s: %s", data_key, exc)

    def clear_namespace(self, namespace: str) -> None:
        pattern = f"{self._prefix}:{namespace}:*"
        try:
            keys = list(self._client.scan_iter(match=pattern, count=500))
            index_key = self._index_key(namespace)
            if keys:
                self._client.delete(*keys)
            self._client.delete(index_key)
        except RedisError as exc:  # pragma: no cover - depends on redis availability
            logger.warning("Redis cache clear namespace failed for %s: %s", namespace, exc)

    def clear_all(self) -> None:
        pattern = f"{self._prefix}:*"
        try:
            keys = list(self._client.scan_iter(match=pattern, count=1000))
            if keys:
                self._client.delete(*keys)
        except RedisError as exc:  # pragma: no cover - depends on redis availability
            logger.warning("Redis cache clear_all failed: %s", exc)

    def close(self) -> None:
        try:
            self._client.close()
        except RedisError:  # pragma: no cover - defensive
            return


class CacheService:
    """Expose cached access to Plex metadata with pluggable backends."""

    DEFAULT_PREFIX = "publex"
    CACHE_BACKEND_MEMORY = "memory"
    CACHE_BACKEND_REDIS = "redis"

    def __init__(
        self,
        settings_service: SettingsService,
        *,
        prefix: Optional[str] = None,
        auto_reload: bool = True,
    ) -> None:
        self._settings = settings_service
        self._prefix = prefix or self.DEFAULT_PREFIX
        self._backend: _CacheBackend = _MemoryCacheBackend(max_entries=0)
        self._config: Dict[str, Any] = {}
        self._lock = threading.RLock()
        if auto_reload:
            self.reload()

    @property
    def backend(self) -> str:
        return str(self._config.get("backend") or self.CACHE_BACKEND_MEMORY)

    @property
    def ttl_seconds(self) -> Optional[int]:
        ttl = self._config.get("ttl_seconds")
        if isinstance(ttl, int) and ttl > 0:
            return ttl
        return None

    @property
    def max_entries(self) -> Optional[int]:
        value = self._config.get("max_entries")
        if isinstance(value, int) and value > 0:
            return value
        return None

    def reload(self) -> None:
        """Reload configuration from persisted settings and rebuild backend if needed."""

        raw = self._settings.get_system_settings(SettingsService.CACHE_NAMESPACE)
        sanitized = self._settings.sanitize_cache_settings(raw)
        backend_kind = self.CACHE_BACKEND_REDIS if sanitized.get("redis_url") else self.CACHE_BACKEND_MEMORY
        backend_error: Optional[str] = None

        new_backend: _CacheBackend
        if backend_kind == self.CACHE_BACKEND_REDIS:
            redis_url = sanitized.get("redis_url") or ""
            try:
                new_backend = _RedisCacheBackend(
                    url=redis_url,
                    max_entries=sanitized.get("max_entries") or 0,
                    prefix=self._prefix,
                )
            except Exception as exc:  # pragma: no cover - redis optional
                backend_error = f"Redis backend could not be initialised: {exc}"
                logger.warning(
                    "Falling back to in-memory cache because %s",
                    backend_error,
                )
                backend_kind = self.CACHE_BACKEND_MEMORY
                new_backend = _MemoryCacheBackend(max_entries=sanitized.get("max_entries") or 0)
        else:
            new_backend = _MemoryCacheBackend(max_entries=sanitized.get("max_entries") or 0)

        with self._lock:
            previous_backend = self._backend
            previous_config = dict(self._config)
            self._backend = new_backend
            self._config = {
                "backend": backend_kind,
                "redis_url": sanitized.get("redis_url", ""),
                "max_entries": sanitized.get("max_entries") or 0,
                "ttl_seconds": sanitized.get("ttl_seconds") or 0,
            }
            self._last_error = backend_error

        if previous_backend is not new_backend:
            try:
                previous_backend.clear_all()
                previous_backend.close()
            except Exception:  # pragma: no cover - defensive
                pass
            logger.info("Cache backend initialised: %s", backend_kind)
        elif previous_config != self._config:
            logger.info("Cache configuration updated: %s", backend_kind)

    def get(self, namespace: str, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            backend = self._backend
        payload = backend.get(namespace, key)
        if payload is None:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            logger.debug("Cache payload for %s:%s was invalid JSON", namespace, key)
            return None

    def set(self, namespace: str, key: str, value: Dict[str, Any], *, ttl: Optional[int] = None) -> None:
        try:
            payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping cache set for %s:%s due to serialization error: %s", namespace, key, exc)
            return
        effective_ttl = ttl if isinstance(ttl, int) and ttl > 0 else self.ttl_seconds
        with self._lock:
            backend = self._backend
        backend.set(namespace, key, payload, effective_ttl)

    def delete(self, namespace: str, key: str) -> None:
        with self._lock:
            backend = self._backend
        backend.delete(namespace, key)

    def clear_namespace(self, namespace: str) -> None:
        with self._lock:
            backend = self._backend
        backend.clear_namespace(namespace)

    def clear_all(self) -> None:
        with self._lock:
            backend = self._backend
        backend.clear_all()

    def snapshot(self) -> Dict[str, Any]:
        """Return the effective configuration in use."""

        with self._lock:
            snapshot = dict(self._config)
            if self._last_error:
                snapshot["last_error"] = self._last_error
        return snapshot


__all__ = ["CacheService"]
