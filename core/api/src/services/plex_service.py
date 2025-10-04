"""Helpers to integrate with Plex using direct HTTP calls."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import threading
import time
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import (
    IO,
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Set,
    Tuple,
    TYPE_CHECKING,
)
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse

import requests
from flask import current_app
from urllib3.exceptions import InsecureRequestWarning

from PIL import Image

from .settings_service import SettingsService

if TYPE_CHECKING:  # pragma: no cover - typing helper
    from .redis_service import RedisService

logger = logging.getLogger(__name__)


class PlexServiceError(RuntimeError):
    """Raised when the Plex integration cannot complete an operation."""


class PlexNotConnectedError(PlexServiceError):
    """Raised when a Plex operation requires stored credentials."""


@dataclass(frozen=True)
class _ImageCachePaths:
    canonical: str
    data_path: Path
    metadata_path: Path
    variant: str = "original"


@dataclass(frozen=True)
class _FetchedImagePayload:
    payload: bytes
    headers: Dict[str, str]
    status_code: int


class PlexClient:
    """Simple helper around ``requests`` for Plex HTTP requests."""

    def __init__(
        self,
        base_url: str,
        token: str,
        headers: Dict[str, str],
        *,
        timeout: int,
        verify: bool = True,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers.update(headers)
        self._session.verify = verify

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def token(self) -> str:
        return self._token

    @property
    def verify(self) -> bool:
        return bool(self._session.verify)

    @property
    def headers(self) -> Dict[str, str]:
        return dict(self._session.headers)

    def _build_url(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return urljoin(f"{self._base_url}/", path.lstrip("/"))

    def _prepare_params(self, params: Optional[Dict[str, Any]], include_token: bool) -> Dict[str, Any]:
        prepared = dict(params or {})
        if include_token and "X-Plex-Token" not in prepared:
            prepared["X-Plex-Token"] = self._token
        return prepared

    def get(
        self,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        parse: bool = True,
        stream: bool = False,
        include_token: bool = True,
    ) -> Any:
        url = self._build_url(path)
        query = self._prepare_params(params, include_token)
        request_headers: Optional[Dict[str, str]] = None
        if not parse or stream:
            request_headers = {
                "Accept": "*/*",
                "X-Plex-Accept": "*/*",
            }

        response = self._session.get(
            url,
            params=query,
            timeout=self._timeout,
            stream=stream,
            headers=request_headers,
        )
        if response.status_code >= 400:
            status = response.status_code
            content = response.text[:200] if not stream else ""
            response.close()
            raise PlexServiceError(
                f"Plex returned HTTP {status} for {path}. Response snippet: {content!r}"
            )
        if not parse:
            return response
        try:
            payload = response.json()
        except ValueError as exc:  # pragma: no cover - depends on Plex response content
            response.close()
            raise PlexServiceError("Plex response was not valid JSON.") from exc
        response.close()
        return payload

    def get_container(
        self,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        include_token: bool = True,
    ) -> Dict[str, Any]:
        payload = self.get(path, params=params, parse=True, include_token=include_token)
        container = payload.get("MediaContainer")
        if container is None:
            raise PlexServiceError("Plex response missing MediaContainer payload.")
        return container


class PlexService:
    """Manage Plex connectivity and library operations via raw HTTP."""

    LETTER_CHOICES: Tuple[str, ...] = tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ("0-9",)
    PLAYABLE_TYPES: Tuple[str, ...] = ("movie", "episode", "clip", "video", "track")
    MAX_SECTION_PAGE_SIZE: int = 500
    MAX_SEARCH_PAGE_SIZE: int = 200
    DEFAULT_SORTS: Tuple[Tuple[str, str, str], ...] = (
        ("title_asc", "Title (A-Z)", "titleSort:asc"),
        ("title_desc", "Title (Z-A)", "titleSort:desc"),
        ("added_desc", "Recently Added", "addedAt:desc"),
        ("added_asc", "Added (Oldest)", "addedAt:asc"),
        ("released_desc", "Release Date (Newest)", "originallyAvailableAt:desc"),
        ("released_asc", "Release Date (Oldest)", "originallyAvailableAt:asc"),
        ("last_viewed_desc", "Last Viewed", "lastViewedAt:desc"),
    )
    IMAGE_HEADER_WHITELIST: Tuple[str, ...] = (
        "Content-Type",
        "Content-Length",
        "Cache-Control",
        "ETag",
        "Last-Modified",
        "Expires",
    )
    DEFAULT_CACHE_CONTROL: str = "public, max-age=86400"
    IMAGE_VARIANT_ORIGINAL: str = "original"
    IMAGE_VARIANT_GRID: str = "grid"
    GRID_THUMBNAIL_MAX_SIZE: Tuple[int, int] = (240, 360)
    GRID_THUMBNAIL_QUALITY: int = 70
    SECTION_CACHE_NAMESPACE: str = "plex.sections"
    SECTION_ITEMS_CACHE_NAMESPACE: str = "plex.section_items"
    SECTION_SNAPSHOTS_CACHE_NAMESPACE: str = "plex.section_snapshots"
    METADATA_CACHE_NAMESPACE: str = "plex.metadata"
    CLIENT_CACHE_TTL_SECONDS: int = 30
    LIBRARY_QUERY_FLAGS: Dict[str, Any] = {
        "checkFiles": 0,
        "includeAllConcerts": 0,
        "includeBandwidths": 0,
        "includeChapters": 0,
        "includeChildren": 0,
        "includeConcerts": 0,
        "includeExtras": 0,
        "includeFields": 0,
        "includeGeolocation": 0,
        "includeLoudnessRamps": 0,
        "includeMarkers": 0,
        "includeOnDeck": 0,
        "includePopularLeaves": 0,
        "includePreferences": 0,
        "includeRelated": 0,
        "includeRelatedCount": 0,
        "includeReviews": 0,
        "includeStations": 0,
    }
    METADATA_QUERY_FLAGS: Dict[str, Any] = {
        "checkFiles": 0,
        "includeAllConcerts": 1,
        "includeBandwidths": 1,
        "includeChapters": 1,
        "includeChildren": 1,
        "includeConcerts": 1,
        "includeExtras": 1,
        "includeFields": 1,
        "includeGeolocation": 1,
        "includeLoudnessRamps": 1,
        "includeMarkers": 1,
        "includeOnDeck": 0,
        "includePopularLeaves": 0,
        "includePreferences": 1,
        "includeRelated": 1,
        "includeRelatedCount": 1,
        "includeReviews": 1,
        "includeStations": 0,
    }
    ACCOUNT_RESOURCE_URL = "https://plex.tv/api/v2/user"

    def __init__(
        self,
        settings_service: SettingsService,
        *,
        redis_service: Optional["RedisService"] = None,
        client_identifier: Optional[str] = None,
        product: Optional[str] = None,
        device_name: Optional[str] = None,
        platform: Optional[str] = None,
        version: Optional[str] = None,
        server_base_url: Optional[str] = None,
        allow_account_lookup: bool = False,
        request_timeout: Optional[int] = None,
        image_cache_dir: Optional[str] = None,
    ) -> None:
        self._settings = settings_service
        self._redis = redis_service
        self._client_identifier = client_identifier or "publex"  # stable default
        self._product = product or "Publex"
        self._device_name = device_name or "Publex Admin"
        self._platform = platform or "Publex"
        self._version = version or "1.0"
        self._server_base_url = (server_base_url or "").strip() or None
        self._allow_account_lookup = bool(allow_account_lookup)
        try:
            timeout_value = int(request_timeout) if request_timeout is not None else 10
        except (TypeError, ValueError):
            timeout_value = 10
        self._request_timeout = max(1, timeout_value)
        self._client_local: threading.local = threading.local()
        self._client_cache_ttl = max(1, int(self.CLIENT_CACHE_TTL_SECONDS))
        self._image_cache_dir: Optional[Path] = None
        if image_cache_dir:
            try:
                cache_dir = Path(image_cache_dir).expanduser()
                cache_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                logger.warning(
                    "Unable to prepare Plex image cache directory %s: %s",
                    image_cache_dir,
                    exc,
                )
            else:
                self._image_cache_dir = cache_dir

    def _library_settings(self) -> Dict[str, Any]:
        return self._settings.get_sanitized_library_settings()

    def _thumbnail_config(self) -> Tuple[int, int, int]:
        settings = self._library_settings()
        try:
            width = int(settings.get("image_cache_thumb_width") or self.GRID_THUMBNAIL_MAX_SIZE[0])
        except (TypeError, ValueError):
            width = self.GRID_THUMBNAIL_MAX_SIZE[0]
        try:
            height = int(settings.get("image_cache_thumb_height") or self.GRID_THUMBNAIL_MAX_SIZE[1])
        except (TypeError, ValueError):
            height = self.GRID_THUMBNAIL_MAX_SIZE[1]
        try:
            quality = int(settings.get("image_cache_thumb_quality") or self.GRID_THUMBNAIL_QUALITY)
        except (TypeError, ValueError):
            quality = self.GRID_THUMBNAIL_QUALITY
        width = max(64, min(width, 1920))
        height = max(64, min(height, 1920))
        quality = max(10, min(quality, 100))
        return width, height, quality

    # ------------------------------------------------------------------
    # Cache helpers

    def _cache_scope(self) -> Optional[str]:
        if not self._redis or not self._redis.available:
            return None
        try:
            base_url = self._get_server_base_url()
            token = self._get_token()
        except PlexNotConnectedError:
            return None
        material = f"{base_url.strip().lower()}|{token}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def _build_cache_key(*parts: Any) -> str:
        canonical: list[str] = []
        for part in parts:
            if isinstance(part, (dict, list, tuple)):
                try:
                    canonical.append(
                        json.dumps(part, sort_keys=True, separators=(",", ":"), default=str)
                    )
                except (TypeError, ValueError):  # pragma: no cover - defensive
                    canonical.append(str(part))
            else:
                canonical.append(str(part))
        digest_input = "::".join(canonical)
        return hashlib.sha256(digest_input.encode("utf-8")).hexdigest()

    def _cache_get(self, namespace: str, key: Optional[str]) -> Optional[Dict[str, Any]]:
        if not key or not self._redis or not self._redis.available:
            return None
        return self._redis.cache_get(namespace, key)

    def _cache_set(self, namespace: str, key: Optional[str], payload: Dict[str, Any]) -> None:
        if not key or not self._redis or not self._redis.available:
            return
        self._redis.cache_set(namespace, key, payload)

    def _cache_delete(self, namespace: str, key: Optional[str]) -> None:
        if not key or not self._redis or not self._redis.available:
            return
        self._redis.cache_delete(namespace, key)

    def _sections_cache_key(self, scope: str) -> str:
        return self._build_cache_key(scope, "sections_snapshot")

    def _library_settings_signature(self, settings: Dict[str, Any]) -> str:
        return self._build_cache_key("library_settings", settings)

    def _invalidate_all_caches(self) -> None:
        self._invalidate_cached_client()
        if not self._redis or not self._redis.available:
            return
        for namespace in (
            self.SECTION_CACHE_NAMESPACE,
            self.SECTION_ITEMS_CACHE_NAMESPACE,
            self.METADATA_CACHE_NAMESPACE,
            self.SECTION_SNAPSHOTS_CACHE_NAMESPACE,
        ):
            self._redis.clear_namespace(namespace)

    def _get_cached_client(
        self,
        *,
        base_url: str,
        token: str,
        verify_ssl: bool,
    ) -> Optional[Tuple[PlexClient, Dict[str, Any]]]:
        state = getattr(self._client_local, "client_state", None)
        if not isinstance(state, dict):
            return None
        if (
            state.get("base_url") != base_url
            or state.get("token") != token
            or state.get("verify_ssl") is not verify_ssl
        ):
            return None
        expires_at = state.get("expires_at")
        if isinstance(expires_at, (int, float)) and time.monotonic() > expires_at:
            return None
        client = state.get("client")
        snapshot = state.get("snapshot")
        if client is None or snapshot is None:
            return None
        return client, snapshot

    def _store_cached_client(
        self,
        *,
        client: PlexClient,
        snapshot: Dict[str, Any],
        base_url: str,
        token: str,
        verify_ssl: bool,
    ) -> None:
        state = {
            "client": client,
            "snapshot": snapshot,
            "base_url": base_url,
            "token": token,
            "verify_ssl": verify_ssl,
            "expires_at": time.monotonic() + self._client_cache_ttl,
        }
        self._client_local.client_state = state

    def _invalidate_cached_client(self) -> None:
        if hasattr(self._client_local, "client_state"):
            self._client_local.client_state = {}

    @staticmethod
    def _apply_hidden_flags(
        sections: Iterable[Dict[str, Any]],
        hidden_identifiers: Iterable[Any],
    ) -> List[Dict[str, Any]]:
        hidden_set = {str(identifier) for identifier in hidden_identifiers if identifier is not None}
        result: List[Dict[str, Any]] = []
        for entry in sections:
            if not isinstance(entry, dict):
                continue
            normalized = dict(entry)
            identifier = normalized.get("identifier")
            if not identifier:
                value = normalized.get("id")
                if value is not None:
                    identifier = str(value)
                    normalized.setdefault("identifier", identifier)
                elif normalized.get("uuid"):
                    identifier = str(normalized["uuid"])
                    normalized.setdefault("identifier", identifier)
                elif normalized.get("key"):
                    identifier = str(normalized["key"]).replace("/library/sections/", "").strip()
                    normalized.setdefault("identifier", identifier)
            normalized["is_hidden"] = bool(identifier and identifier in hidden_set)
            result.append(normalized)
        return result

    @staticmethod
    def _snapshot_identity(item: Mapping[str, Any]) -> Optional[str]:
        for key in ("rating_key", "ratingKey", "id", "key"):
            value = item.get(key)
            if value is None:
                continue
            try:
                identifier = str(value).strip()
            except Exception:  # pragma: no cover - defensive
                identifier = None
            if identifier:
                return identifier
        return None

    def _snapshot_key(self, scope: str, section_id: Any) -> str:
        return self._build_cache_key(scope, "section", section_id)

    @staticmethod
    def _normalize_signature_value(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, str):
            stripped = value.strip()
            return stripped if stripped else ""
        try:
            return str(value)
        except Exception:  # pragma: no cover - defensive
            return None

    def _normalize_snapshot_signature(self, signature: Optional[Mapping[str, Any]]) -> Tuple[Tuple[str, Optional[str]], ...]:
        if not signature:
            return tuple()
        normalized: List[Tuple[str, Optional[str]]] = []
        for key, value in signature.items():
            normalized.append((str(key), self._normalize_signature_value(value)))
        normalized.sort(key=lambda item: item[0])
        return tuple(normalized)

    def _snapshot_signatures_equal(
        self,
        existing: Optional[Mapping[str, Any]],
        candidate: Optional[Mapping[str, Any]],
    ) -> bool:
        return self._normalize_snapshot_signature(existing) == self._normalize_snapshot_signature(candidate)

    def _build_snapshot_request_signature(
        self,
        *,
        sort: Optional[str],
        sort_param: Optional[str],
        letter: Optional[str],
        search: Optional[str],
        watch_state: Optional[str],
        genre: Optional[str],
        collection: Optional[str],
        year: Optional[str],
        limit: int,
    ) -> Dict[str, Any]:
        return {
            "version": 1,
            "sort": sort or None,
            "sort_param": sort_param or None,
            "letter": letter or None,
            "search": search or None,
            "watch": watch_state or None,
            "genre": genre or None,
            "collection": collection or None,
            "year": year or None,
            "limit": int(limit),
        }

    def _get_section_snapshot(self, scope: Optional[str], section_id: Any) -> Optional[Dict[str, Any]]:
        if not scope or not self._redis or not self._redis.available:
            return None
        key = self._snapshot_key(scope, section_id)
        return self._cache_get(self.SECTION_SNAPSHOTS_CACHE_NAMESPACE, key)

    def _empty_section_snapshot(self, section_id: Any) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        return {
            "section_id": str(section_id),
            "items": [],
            "total": None,
            "cursor": 0,
            "completed": False,
            "updated_at": now,
            "request_signature": None,
        }

    def _merge_section_snapshot(
        self,
        section_id: Any,
        scope: Optional[str],
        payload: Mapping[str, Any],
        *,
        request_signature: Optional[Mapping[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        if not scope or not self._redis or not self._redis.available:
            return None

        key = self._snapshot_key(scope, section_id)
        existing = self._cache_get(self.SECTION_SNAPSHOTS_CACHE_NAMESPACE, key)
        if not isinstance(existing, dict):
            existing = self._empty_section_snapshot(section_id)

        normalized_request_signature = dict(request_signature) if isinstance(request_signature, Mapping) else None
        if (
            normalized_request_signature
            and existing.get("request_signature")
            and not self._snapshot_signatures_equal(existing.get("request_signature"), normalized_request_signature)
        ):
            logger.info(
                "Clearing cached snapshot for section=%s due to signature mismatch",
                section_id,
            )
            existing = self._empty_section_snapshot(section_id)

        items = existing.get("items")
        if not isinstance(items, list):
            items = []

        pagination = payload.get("pagination") if isinstance(payload.get("pagination"), Mapping) else {}
        page_offset_raw = pagination.get("offset")
        try:
            page_offset = int(page_offset_raw) if page_offset_raw is not None else None
        except (TypeError, ValueError):
            page_offset = None
        if page_offset is not None and page_offset < 0:
            page_offset = 0

        order: List[str] = []
        index: Dict[str, Dict[str, Any]] = {}

        for item in items:
            if not isinstance(item, Mapping):
                continue
            identifier = self._snapshot_identity(item)
            if not identifier:
                continue
            if identifier not in index:
                order.append(identifier)
            index[identifier] = dict(item)

        order_positions = {identifier: position for position, identifier in enumerate(order)}

        for item_index, item in enumerate(payload.get("items", []) or []):
            if not isinstance(item, Mapping):
                continue
            identifier = self._snapshot_identity(item)
            if not identifier:
                continue
            index[identifier] = dict(item)

            target_index: Optional[int] = None
            if page_offset is not None:
                target_index = page_offset + item_index
                if target_index < 0:
                    target_index = 0

            current_index = order_positions.get(identifier)
            if current_index is not None:
                if target_index is not None and current_index == target_index:
                    continue
                order.pop(current_index)
                del order_positions[identifier]
                for position in range(current_index, len(order)):
                    order_positions[order[position]] = position
                if target_index is not None and target_index > current_index:
                    target_index -= 1

            if target_index is None or target_index >= len(order):
                order.append(identifier)
                order_positions[identifier] = len(order) - 1
            else:
                order.insert(target_index, identifier)
                for position in range(target_index, len(order)):
                    order_positions[order[position]] = position

        merged_items = [index[identifier] for identifier in order if identifier in index]

        total_results = pagination.get("total")
        try:
            total_value = int(total_results) if total_results is not None else None
        except (TypeError, ValueError):
            total_value = existing.get("total")

        cursor = pagination.get("offset") or 0
        try:
            cursor = int(cursor)
        except (TypeError, ValueError):
            cursor = existing.get("cursor") or 0
        cursor += len(payload.get("items", []) or [])

        now = datetime.now(timezone.utc).isoformat()

        snapshot = dict(existing)
        snapshot["items"] = merged_items
        snapshot["total"] = total_value if total_value is not None else existing.get("total")
        snapshot["cursor"] = max(cursor, existing.get("cursor", 0) or 0)
        snapshot["updated_at"] = now
        if normalized_request_signature:
            snapshot["request_signature"] = normalized_request_signature
        target_total = snapshot.get("total")
        if isinstance(target_total, int) and target_total > 0:
            snapshot["completed"] = len(merged_items) >= target_total
        else:
            snapshot["completed"] = bool(snapshot.get("completed"))

        if isinstance(payload.get("server"), Mapping):
            snapshot["server"] = payload.get("server")
        if isinstance(payload.get("section"), Mapping):
            snapshot["section"] = payload.get("section")
        if isinstance(payload.get("sort_options"), list):
            snapshot["sort_options"] = payload.get("sort_options")

        self._cache_set(self.SECTION_SNAPSHOTS_CACHE_NAMESPACE, key, snapshot)
        return snapshot

    def _section_payload_from_snapshot(
        self,
        *,
        section_id: Any,
        snapshot: Mapping[str, Any],
        offset: int,
        limit: int,
        normalized_letter: Optional[str],
        title_query: Optional[str],
        watch_state: Optional[str],
        genre: Optional[str],
        collection: Optional[str],
        year: Optional[str],
        sort: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        items = snapshot.get("items") if isinstance(snapshot.get("items"), list) else None
        if items is None:
            return None

        total_value = snapshot.get("total")
        if not isinstance(total_value, int) or total_value < 0:
            total_value = len(items)

        start_index = min(max(offset, 0), len(items))
        end_index = min(start_index + max(limit, 1), len(items))
        subset = items[start_index:end_index]

        request_signature = snapshot.get("request_signature") if isinstance(snapshot.get("request_signature"), Mapping) else {}

        applied = {
            "sort": request_signature.get("sort") or sort,
            "search": request_signature.get("search") or title_query,
            "watch_state": request_signature.get("watch") or watch_state,
            "genre": request_signature.get("genre") or genre,
            "collection": request_signature.get("collection") or collection,
            "year": request_signature.get("year") or year,
        }

        payload = {
            "server": snapshot.get("server"),
            "section": snapshot.get("section") or {"id": str(section_id)},
            "items": subset,
            "pagination": {
                "offset": offset,
                "limit": limit,
                "total": total_value,
                "size": len(subset),
            },
            "sort_options": snapshot.get("sort_options") or self._sort_options(),
            "letter": normalized_letter,
            "filters": {},
            "applied": applied,
        }
        payload["snapshot"] = self._snapshot_summary(snapshot, include_items=False)
        return payload

    def _snapshot_summary(
        self,
        snapshot: Optional[Mapping[str, Any]],
        *,
        include_items: bool = False,
        max_items: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not snapshot:
            return {
                "section_id": None,
                "cached": 0,
                "total": None,
                "completed": False,
                "updated_at": None,
            }
        total_items = snapshot.get("items") if isinstance(snapshot.get("items"), list) else []
        cached_count = len(total_items)
        total_value = snapshot.get("total")
        summary: Dict[str, Any] = {
            "section_id": snapshot.get("section_id"),
            "cached": cached_count,
            "total": total_value,
            "completed": bool(snapshot.get("completed"))
            or (isinstance(total_value, int) and total_value > 0 and cached_count >= total_value),
            "updated_at": snapshot.get("updated_at"),
        }
        if include_items:
            if max_items is not None and isinstance(max_items, int) and max_items >= 0:
                summary["items"] = total_items[:max_items]
            else:
                summary["items"] = total_items
        if snapshot.get("request_signature"):
            summary["request_signature"] = snapshot.get("request_signature")
        if snapshot.get("section"):
            summary["section"] = snapshot.get("section")
        if snapshot.get("server"):
            summary["server"] = snapshot.get("server")
        if snapshot.get("sort_options"):
            summary["sort_options"] = snapshot.get("sort_options")
        return summary

    def get_section_snapshot(
        self,
        section_id: Any,
        *,
        include_items: bool = False,
        max_items: Optional[int] = None,
    ) -> Dict[str, Any]:
        scope = self._cache_scope()
        snapshot = self._get_section_snapshot(scope, section_id)
        if not snapshot:
            snapshot = self._empty_section_snapshot(section_id)
        return self._snapshot_summary(snapshot, include_items=include_items, max_items=max_items)

    def clear_section_snapshot(self, section_id: Any) -> None:
        scope = self._cache_scope()
        if not scope or not self._redis or not self._redis.available:
            return
        key = self._snapshot_key(scope, section_id)
        self._cache_delete(self.SECTION_SNAPSHOTS_CACHE_NAMESPACE, key)

    def build_section_snapshot(
        self,
        section_id: Any,
        *,
        sort: Optional[str] = None,
        page_size: Optional[int] = None,
        max_items: Optional[int] = None,
        parallelism: Optional[int] = None,
    ) -> Dict[str, Any]:
        scope = self._cache_scope()
        if not scope:
            raise PlexServiceError("Unable to build snapshot without an active Plex connection.")

        try:
            workers = int(parallelism) if parallelism is not None else 1
        except (TypeError, ValueError):
            workers = 1
        workers = max(1, min(workers, 16))

        logger.info("Building section snapshot for %s (parallelism=%s)", section_id, workers)
        self.clear_section_snapshot(section_id)

        limit = page_size if isinstance(page_size, int) and page_size > 0 else self.MAX_SECTION_PAGE_SIZE
        limit = max(1, min(limit, self.MAX_SECTION_PAGE_SIZE))

        initial_payload = self.section_items(
            section_id,
            sort=sort,
            offset=0,
            limit=limit,
            force_refresh=True,
            snapshot_merge=True,
        )
        first_items = initial_payload.get("items") or []
        pagination = (
            initial_payload.get("pagination")
            if isinstance(initial_payload.get("pagination"), Mapping)
            else {}
        )
        try:
            total = int(pagination.get("total")) if pagination.get("total") is not None else None
        except (TypeError, ValueError):
            total = None

        request_signature: Optional[Mapping[str, Any]] = None
        snapshot_summary = initial_payload.get("snapshot")
        if isinstance(snapshot_summary, Mapping) and isinstance(snapshot_summary.get("request_signature"), Mapping):
            request_signature = snapshot_summary.get("request_signature")
        else:
            applied = initial_payload.get("applied") if isinstance(initial_payload.get("applied"), Mapping) else {}
            request_signature = {
                "sort": self._resolve_sort(sort) if sort else None,
                "letter": initial_payload.get("letter"),
                "search": applied.get("search"),
                "genre": applied.get("genre"),
                "collection": applied.get("collection"),
                "year": applied.get("year"),
            }

        current_offset = len(first_items)
        remaining_offsets: List[int] = []
        if isinstance(total, int) and total > current_offset:
            remaining_offsets = list(range(current_offset, total, limit))

        flask_app = None
        try:
            flask_app = current_app._get_current_object()
        except RuntimeError:
            flask_app = None

        if workers <= 1 or not remaining_offsets or flask_app is None:
            while True:
                if isinstance(total, int) and current_offset >= total:
                    break
                payload = self.section_items(
                    section_id,
                    sort=sort,
                    offset=current_offset,
                    limit=limit,
                    force_refresh=True,
                    snapshot_merge=True,
                )
                page_items = payload.get("items") or []
                if not page_items:
                    break
                current_offset += len(page_items)
                if isinstance(total, int) and current_offset >= total:
                    break
                if len(page_items) < limit:
                    break
        else:
            def fetch_page(page_offset: int) -> Tuple[int, Dict[str, Any]]:
                with flask_app.app_context():
                    payload = self.section_items(
                        section_id,
                        sort=sort,
                        offset=page_offset,
                        limit=limit,
                        force_refresh=True,
                        snapshot_merge=False,
                    )
                return page_offset, payload

            max_workers = min(workers, max(1, len(remaining_offsets)))
            results: List[Tuple[int, Dict[str, Any]]] = []
            try:
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_map = {
                        executor.submit(fetch_page, offset_value): offset_value
                        for offset_value in remaining_offsets
                    }
                    for future in as_completed(future_map):
                        offset_value = future_map[future]
                        payload = future.result()
                        results.append(payload)
            except Exception as exc:  # pragma: no cover - depends on Plex availability
                logger.exception("Failed to load Plex items in parallel for section %s: %s", section_id, exc)
                raise PlexServiceError("Unable to load Plex library items.") from exc

            for offset_value, payload in sorted(results, key=lambda item: item[0]):
                pagination_info = payload.get("pagination")
                if isinstance(pagination_info, dict):
                    pagination_info["offset"] = offset_value
                self._merge_section_snapshot(
                    section_id,
                    scope,
                    payload,
                    request_signature=request_signature,
                )

        snapshot = self._get_section_snapshot(scope, section_id)
        return self._snapshot_summary(snapshot, include_items=True, max_items=max_items)

    def prepare_section_snapshot_plan(
        self,
        section_id: Any,
        *,
        sort: Optional[str] = None,
        letter: Optional[str] = None,
        search: Optional[str] = None,
        watch_state: Optional[str] = None,
        genre: Optional[str] = None,
        collection: Optional[str] = None,
        year: Optional[str] = None,
        page_size: Optional[int] = None,
        max_items: Optional[int] = None,
        reset: bool = False,
    ) -> Dict[str, Any]:
        scope = self._cache_scope()
        if not scope:
            raise PlexServiceError("Unable to prepare snapshot plan without an active Plex connection.")

        if reset:
            self.clear_section_snapshot(section_id)

        sort_param = self._resolve_sort(sort)

        try:
            limit = int(page_size) if page_size is not None else self.MAX_SECTION_PAGE_SIZE
        except (TypeError, ValueError):
            limit = self.MAX_SECTION_PAGE_SIZE
        limit = max(1, min(limit, self.MAX_SECTION_PAGE_SIZE))

        request_signature = self._build_snapshot_request_signature(
            sort=sort,
            sort_param=sort_param,
            letter=self._normalize_letter(letter),
            search=search.strip() if isinstance(search, str) else None,
            watch_state=watch_state,
            genre=genre,
            collection=collection,
            year=year,
            limit=limit,
        )

        snapshot = self._get_section_snapshot(scope, section_id)
        if snapshot and snapshot.get("request_signature") and not self._snapshot_signatures_equal(
            snapshot.get("request_signature"),
            request_signature,
        ):
            logger.info(
                "Existing snapshot signature differs; clearing cached data (section=%s)",
                section_id,
            )
            self.clear_section_snapshot(section_id)
            snapshot = None

        if not snapshot or not isinstance(snapshot.get("items"), list) or not snapshot.get("items"):
            self.section_items(
                section_id,
                sort=sort,
                letter=letter,
                search=search,
                watch_state=watch_state,
                genre=genre,
                collection=collection,
                year=year,
                offset=0,
                limit=limit,
                force_refresh=True,
                snapshot_merge=True,
                prefer_cache=False,
            )
            snapshot = self._get_section_snapshot(scope, section_id)

        if not snapshot:
            snapshot = self._empty_section_snapshot(section_id)

        cached_items = snapshot.get("items") if isinstance(snapshot.get("items"), list) else []
        cached_count = len(cached_items)

        cursor = snapshot.get("cursor") or cached_count
        try:
            cursor = int(cursor)
        except (TypeError, ValueError):
            cursor = cached_count
        cursor = max(cursor, cached_count)

        summary = self._snapshot_summary(snapshot)
        total_value = summary.get("total") if isinstance(summary.get("total"), int) else None

        target_total = total_value
        if isinstance(max_items, int) and max_items > 0:
            if target_total is None:
                target_total = max_items
            else:
                target_total = min(target_total, max_items)

        completed = bool(summary.get("completed"))
        if target_total is not None and cached_count >= target_total:
            completed = True

        if isinstance(target_total, int):
            cursor = min(cursor, target_total)
        elif isinstance(total_value, int) and total_value >= 0:
            cursor = min(cursor, total_value)

        offsets: Set[int] = set()
        if not completed:
            if target_total is None:
                partial_boundary = (cached_count // limit) * limit
                if cached_count % limit != 0 and partial_boundary >= 0:
                    offsets.add(partial_boundary)
                base_offset = max(cursor, cached_count)
                if base_offset >= 0:
                    offsets.add(base_offset)
            else:
                first_missing_boundary = (cached_count // limit) * limit
                if cached_count % limit != 0 and first_missing_boundary >= 0:
                    offsets.add(first_missing_boundary)

                next_offset = first_missing_boundary + limit
                if cached_count % limit == 0:
                    next_offset = max(cached_count, first_missing_boundary)
                while next_offset < target_total:
                    if next_offset >= 0:
                        offsets.add(next_offset)
                    next_offset += limit

        offsets_list = sorted(int(value) for value in offsets if value >= 0)

        plan = {
            "section_id": str(section_id),
            "limit": limit,
            "cached": cached_count,
            "total": total_value,
            "cursor": cursor,
            "completed": completed and not offsets_list,
            "request": {
                "sort": sort,
                "letter": letter,
                "search": search,
                "watch": watch_state,
                "genre": genre,
                "collection": collection,
                "year": year,
            },
            "request_signature": snapshot.get("request_signature"),
            "queued_offsets": offsets_list,
            "snapshot": summary,
        }
        if isinstance(target_total, int):
            plan["target_total"] = target_total
        if isinstance(max_items, int) and max_items > 0:
            plan["max_items"] = max_items
        return plan

    def fetch_section_snapshot_chunk(
        self,
        section_id: Any,
        *,
        sort: Optional[str] = None,
        letter: Optional[str] = None,
        search: Optional[str] = None,
        watch_state: Optional[str] = None,
        genre: Optional[str] = None,
        collection: Optional[str] = None,
        year: Optional[str] = None,
        offset: int = 0,
        limit: int = 500,
    ) -> Dict[str, Any]:
        self.section_items(
            section_id,
            sort=sort,
            letter=letter,
            search=search,
            watch_state=watch_state,
            genre=genre,
            collection=collection,
            year=year,
            offset=offset,
            limit=limit,
            force_refresh=True,
            snapshot_merge=True,
            prefer_cache=False,
        )
        scope = self._cache_scope()
        snapshot = self._get_section_snapshot(scope, section_id)
        return self._snapshot_summary(snapshot)

    def _compute_sections_payload(
        self,
        library_settings: Dict[str, Any],
        hidden_identifiers: Iterable[Any],
    ) -> Dict[str, Any]:
        client, snapshot = self._connect_client()
        server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"
        logger.info(
            "Listing Plex sections (server=%s, base_url=%s)",
            server_name,
            snapshot.get("base_url"),
        )

        try:
            container = client.get_container("/library/sections")
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.exception("Failed to list Plex sections: %s", exc)
            raise PlexServiceError("Unable to load Plex library sections.") from exc

        raw_sections = [
            self._serialize_section(entry)
            for entry in self._ensure_list(container.get("Directory"))
        ]
        sections = self._apply_hidden_flags(raw_sections, hidden_identifiers)

        payload = {
            "server": snapshot,
            "sections": sections,
            "sort_options": self._sort_options(),
            "letters": list(self.LETTER_CHOICES),
            "library_settings": library_settings,
        }

        logger.info("Loaded %d Plex sections from server=%s", len(sections), server_name)
        return payload

    # ------------------------------------------------------------------
    # Public API

    def connect(
        self,
        *,
        server_url: str,
        token: str,
        verify_ssl: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Connect to a Plex server using the provided token."""

        normalized_url = self._normalize_server_url(server_url)
        token_value = str(token or "").strip()
        if not token_value:
            raise PlexServiceError("A Plex authentication token is required.")

        verify = True if verify_ssl is None else bool(verify_ssl)

        try:
            client, actual_verify = self._build_client(normalized_url, token_value, verify)
            identity = client.get_container("/identity")
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to connect to Plex server at %s: %s", normalized_url, exc)
            raise PlexServiceError("Unable to connect to the Plex server with the provided details.") from exc

        account_info = None
        if self._allow_account_lookup:
            account_info = self._load_account_snapshot(client)

        snapshot = self._build_snapshot(identity, base_url=normalized_url, verify_ssl=actual_verify)
        now = datetime.now(timezone.utc).isoformat()

        self._update_settings({
            "status": "connected",
            "auth_token": token_value,
            "server_base_url": normalized_url,
            "verify_ssl": actual_verify,
            "account": account_info,
            "last_connected_at": now,
            "server": snapshot,
        })

        self._invalidate_all_caches()

        return {
            "status": "connected",
            "account": account_info,
            "server": snapshot,
            "last_connected_at": now,
            "verify_ssl": actual_verify,
            "has_token": True,
        }

    def disconnect(self) -> Dict[str, Any]:
        """Remove any persisted Plex credentials."""

        logger.info("Disconnecting Plex account and clearing stored token")
        self._update_settings({
            "status": "disconnected",
            "auth_token": None,
            "account": None,
            "server": None,
            "last_connected_at": None,
        })
        self._invalidate_all_caches()
        return {"status": "disconnected"}

    def get_account_snapshot(self) -> Dict[str, Any]:
        """Return the stored account metadata without revealing the token."""

        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        account = settings.get("account") or None
        status = settings.get("status") or "disconnected"
        last_connected_at = settings.get("last_connected_at")
        has_token = bool(settings.get("auth_token"))
        server_base_url = settings.get("server_base_url") or self._server_base_url
        verify_ssl = settings.get("verify_ssl")
        server_info = settings.get("server") or None
        return {
            "status": status,
            "account": account,
            "last_connected_at": last_connected_at,
            "has_token": has_token,
            "server_base_url": server_base_url,
            "verify_ssl": bool(verify_ssl) if isinstance(verify_ssl, bool) else True,
            "server": server_info,
        }

    def build_sections_snapshot(self, *, force_refresh: bool = False) -> Dict[str, Any]:
        """Return the precomputed Plex sections snapshot, rebuilding if needed."""

        library_settings = self._library_settings()
        hidden_identifiers = set(library_settings.get("hidden_sections", []))
        settings_signature = self._library_settings_signature(library_settings)

        scope = self._cache_scope()
        cache_key: Optional[str] = None
        if scope:
            cache_key = self._sections_cache_key(scope)
            if not force_refresh:
                cached = self._cache_get(self.SECTION_CACHE_NAMESPACE, cache_key)
                if cached and cached.get("settings_signature") == settings_signature:
                    snapshot = dict(cached)
                    snapshot["library_settings"] = library_settings
                    snapshot.pop("settings_signature", None)
                    logger.info("Serving cached Plex sections (scope=%s)", scope[:8])
                    return snapshot

        snapshot = dict(
            self._compute_sections_payload(
                library_settings,
                hidden_identifiers,
            )
        )
        snapshot["generated_at"] = datetime.now(timezone.utc).isoformat()
        snapshot["settings_signature"] = settings_signature

        if cache_key:
            self._cache_set(self.SECTION_CACHE_NAMESPACE, cache_key, snapshot)

        result = dict(snapshot)
        result.pop("settings_signature", None)
        return result

    def list_sections(self, *, force_refresh: bool = False) -> Dict[str, Any]:
        """Return available Plex library sections and server metadata."""

        return self.build_sections_snapshot(force_refresh=force_refresh)

    def section_items(
        self,
        section_id: Any,
        *,
        sort: Optional[str] = None,
        letter: Optional[str] = None,
        search: Optional[str] = None,
        watch_state: Optional[str] = None,
        genre: Optional[str] = None,
        collection: Optional[str] = None,
        year: Optional[str] = None,
        offset: int = 0,
        limit: int = 60,
        force_refresh: bool = False,
        snapshot_merge: bool = False,
        prefer_cache: bool = True,
    ) -> Dict[str, Any]:
        """Browse a Plex library section applying the provided filters."""

        offset = max(0, int(offset))
        library_settings = self._library_settings()
        section_page_size = library_settings.get("section_page_size")
        if isinstance(section_page_size, int):
            max_page_size = section_page_size
        else:
            try:
                max_page_size = int(section_page_size)
            except (TypeError, ValueError):
                max_page_size = self.MAX_SECTION_PAGE_SIZE
        max_page_size = max(1, min(max_page_size, 1000))
        try:
            requested_limit = int(limit)
        except (TypeError, ValueError):
            requested_limit = max_page_size
        limit = max(1, min(requested_limit, max_page_size))

        prefer_cache = prefer_cache and not force_refresh

        normalized_letter = self._normalize_letter(letter)
        path = self._section_path(section_id)

        params: Dict[str, Any] = dict(self.LIBRARY_QUERY_FLAGS)
        params["X-Plex-Container-Start"] = offset
        params["X-Plex-Container-Size"] = limit

        sort_param = self._resolve_sort(sort)
        if sort_param:
            params["sort"] = sort_param

        title_query = search.strip() if isinstance(search, str) else None
        if title_query:
            params["title"] = title_query

        if normalized_letter:
            params["firstCharacter"] = "#" if normalized_letter == "0-9" else normalized_letter

        if watch_state == "unwatched":
            params["unwatched"] = 1
        elif watch_state == "in_progress":
            params["inProgress"] = 1
        elif watch_state == "watched":
            params["viewCount>>"] = 0

        if genre:
            params["genre"] = genre
        if collection:
            params["collection"] = collection
        if year:
            params["year"] = year

        request_signature = self._build_snapshot_request_signature(
            sort=sort,
            sort_param=sort_param,
            letter=normalized_letter,
            search=title_query,
            watch_state=watch_state,
            genre=genre,
            collection=collection,
            year=year,
            limit=limit,
        )

        scope = self._cache_scope()
        cache_key: Optional[str] = None
        if scope:
            signature = {
                "section_id": str(section_id),
                "offset": offset,
                "limit": limit,
                "sort": sort or "",
                "letter": normalized_letter or "",
                "search": title_query or "",
                "watch_state": watch_state or "",
                "genre": genre or "",
                "collection": collection or "",
                "year": year or "",
            }
            cache_key = self._build_cache_key(scope, signature)
            if not force_refresh:
                cached = self._cache_get(self.SECTION_ITEMS_CACHE_NAMESPACE, cache_key)
                if cached:
                    logger.info(
                        "Serving cached Plex section items (section=%s, scope=%s)",
                        section_id,
                        scope[:8],
                    )
                    return cached

        snapshot_payload: Optional[Dict[str, Any]] = None
        if scope and prefer_cache:
            cached_snapshot = self._get_section_snapshot(scope, section_id)
            if cached_snapshot and (
                not cached_snapshot.get("request_signature")
                or self._snapshot_signatures_equal(cached_snapshot.get("request_signature"), request_signature)
            ):
                snapshot_payload = self._section_payload_from_snapshot(
                    section_id=section_id,
                    snapshot=cached_snapshot,
                    offset=offset,
                    limit=limit,
                    normalized_letter=normalized_letter,
                    title_query=title_query,
                    watch_state=watch_state,
                    genre=genre,
                    collection=collection,
                    year=year,
                    sort=sort,
                )
                if snapshot_payload is not None:
                    logger.info(
                        "Serving section %s items from snapshot cache (offset=%s, limit=%s)",
                        section_id,
                        offset,
                        limit,
                    )
                    return snapshot_payload

        snapshot: Optional[Dict[str, Any]] = None
        container: Optional[Dict[str, Any]] = None
        server_name = "unknown"
        last_error: Optional[Exception] = None

        for attempt in range(2):
            try:
                client, snapshot = self._connect_client(force_refresh=attempt > 0)
                server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"
                container = client.get_container(path, params=params)
                break
            except PlexServiceError:
                raise
            except Exception as exc:  # pragma: no cover - depends on Plex availability
                last_error = exc
                self._invalidate_cached_client()
                if attempt == 0:
                    logger.warning(
                        "Plex request failed for section %s (retrying with fresh client): %s",
                        section_id,
                        exc,
                    )
                    continue
                logger.exception("Failed to load Plex items for section %s: %s", section_id, exc)
                raise PlexServiceError("Unable to load Plex library items.") from exc

        if container is None or snapshot is None:
            if last_error is not None:
                logger.exception("Failed to load Plex items for section %s: %s", section_id, last_error)
                raise PlexServiceError("Unable to load Plex library items.") from last_error
            raise PlexServiceError("Unable to load Plex library items.")

        items = [
            self._serialize_item_overview(item, include_tags=False)
            for item in self._extract_items(container)
        ]

        total_results = self._safe_int(self._value(container, "totalSize"))
        if total_results is None:
            total_results = offset + len(items)

        payload = {
            "server": snapshot,
            "section": self._section_entry(container, section_id),
            "items": items,
            "pagination": {
                "offset": offset,
                "limit": limit,
                "total": total_results,
                "size": len(items),
            },
            "sort_options": self._sort_options(),
            "letter": normalized_letter,
            "filters": {},
            "applied": {
                "sort": sort,
                "search": title_query,
                "watch_state": watch_state,
                "genre": genre,
                "collection": collection,
                "year": year,
            },
        }

        if cache_key:
            self._cache_set(self.SECTION_ITEMS_CACHE_NAMESPACE, cache_key, payload)

        if snapshot_merge:
            snapshot_info = self._merge_section_snapshot(
                section_id,
                scope,
                payload,
                request_signature=request_signature,
            )
            if snapshot_info:
                payload["snapshot"] = self._snapshot_summary(snapshot_info)
        elif scope:
            snapshot_info = self._get_section_snapshot(scope, section_id)
            if snapshot_info:
                payload["snapshot"] = self._snapshot_summary(snapshot_info)

        logger.info(
            "Loaded %d Plex items (section=%s, server=%s, total=%s)",
            len(items),
            section_id,
            server_name,
            total_results,
        )
        return payload

    def cache_section_images(
        self,
        section_id: Any,
        *,
        page_size: Optional[int] = None,
        max_items: Optional[int] = None,
        detail_params: Optional[Mapping[str, Any]] = None,
        grid_params: Optional[Mapping[str, Any]] = None,
        force: bool = False,
    ) -> Dict[str, Any]:
        """Populate the Plex image cache for a section's library items."""

        if not self._image_cache_dir:
            raise PlexServiceError("Image caching is not enabled.")

        def _coerce_positive_int(value: Any, default: int) -> int:
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                return default
            if parsed <= 0:
                return default
            return parsed

        library_settings = self._library_settings()
        fallback_page_size = _coerce_positive_int(
            library_settings.get("section_page_size"),
            self.MAX_SECTION_PAGE_SIZE,
        )
        chunk_size = _coerce_positive_int(page_size, fallback_page_size)
        chunk_size = max(1, min(chunk_size, self.MAX_SECTION_PAGE_SIZE))

        try:
            max_items_value = int(max_items) if max_items is not None else None
            if max_items_value is not None and max_items_value <= 0:
                max_items_value = None
        except (TypeError, ValueError):
            max_items_value = None

        detail_defaults = {
            "width": "600",
            "height": "900",
            "min": "1",
            "upscale": "1",
        }
        grid_defaults = {
            "width": "360",
            "height": "540",
            "upscale": "1",
        }

        normalized_detail = self._normalize_image_params(detail_params) or dict(detail_defaults)
        normalized_grid = self._normalize_image_params(grid_params) or dict(grid_defaults)

        detail_signature = tuple(sorted(normalized_detail.items()))
        grid_signature = tuple(sorted(normalized_grid.items()))

        processed_items = 0
        original_requests: set[Tuple[str, Tuple[Tuple[str, str], ...]]] = set()
        grid_requests: set[Tuple[str, Tuple[Tuple[str, str], ...]]] = set()
        downloads = 0
        skips = 0
        grids_created = 0
        errors: List[Dict[str, Any]] = []

        offset = 0
        total_available: Optional[int] = None

        while True:
            payload = self.section_items(
                section_id,
                offset=offset,
                limit=chunk_size,
                force_refresh=False,
                snapshot_merge=False,
                prefer_cache=True,
            )
            items = payload.get("items") or []
            if not items:
                break

            for item in items:
                processed_items += 1
                image_paths = self._collect_item_image_paths(item)
                for image_path in image_paths:
                    original_key = (image_path, detail_signature)
                    if original_key not in original_requests:
                        original_requests.add(original_key)
                        try:
                            stats = self._precache_image(
                                image_path,
                                params=normalized_detail,
                                ensure_grid=False,
                                force=force,
                            )
                            if stats.get("fetched"):
                                downloads += 1
                            elif stats.get("skipped"):
                                skips += 1
                        except PlexServiceError as exc:
                            logger.warning(
                                "Failed to cache Plex image (section=%s, path=%s): %s",
                                section_id,
                                image_path,
                                exc,
                            )
                            errors.append(
                                {
                                    "path": image_path,
                                    "variant": self.IMAGE_VARIANT_ORIGINAL,
                                    "error": str(exc),
                                }
                            )

                    grid_key = (image_path, grid_signature)
                    if grid_key not in grid_requests:
                        grid_requests.add(grid_key)
                        try:
                            stats = self._precache_image(
                                image_path,
                                params=normalized_grid,
                                ensure_grid=True,
                                force=force,
                            )
                            if stats.get("fetched"):
                                downloads += 1
                            elif stats.get("skipped"):
                                skips += 1
                            if stats.get("grid_created"):
                                grids_created += 1
                        except PlexServiceError as exc:
                            logger.warning(
                                "Failed to cache Plex grid thumbnail (section=%s, path=%s): %s",
                                section_id,
                                image_path,
                                exc,
                            )
                            errors.append(
                                {
                                    "path": image_path,
                                    "variant": self.IMAGE_VARIANT_GRID,
                                    "error": str(exc),
                                }
                            )

                if max_items_value is not None and processed_items >= max_items_value:
                    break

            pagination = payload.get("pagination") or {}
            size = pagination.get("size")
            if not isinstance(size, int) or size <= 0:
                size = len(items)
            offset += size

            total_candidate = pagination.get("total")
            if isinstance(total_candidate, int) and total_candidate >= 0:
                total_available = total_candidate

            if (max_items_value is not None and processed_items >= max_items_value) or (
                isinstance(total_available, int) and total_available > 0 and offset >= total_available
            ):
                break

        summary = {
            "section_id": str(section_id),
            "processed_items": processed_items,
            "unique_original": len(original_requests),
            "unique_grid": len(grid_requests),
            "downloads": downloads,
            "skipped": skips,
            "grid_generated": grids_created,
            "page_size": chunk_size,
            "max_items": max_items_value,
            "errors": errors,
        }

        logger.info(
            "Cached Plex artwork (section=%s, items=%s, downloads=%s, grids=%s, errors=%s)",
            section_id,
            processed_items,
            downloads,
            grids_created,
            len(errors),
        )

        return summary

    def section_collections(
        self,
        section_id: Any,
        *,
        offset: int = 0,
        limit: int = 60,
    ) -> Dict[str, Any]:
        try:
            start = int(offset)
        except (TypeError, ValueError):
            start = 0
        try:
            page_size = int(limit)
        except (TypeError, ValueError):
            page_size = 60
        start = max(0, start)
        page_size = max(1, min(page_size, self.MAX_SECTION_PAGE_SIZE))

        client, snapshot = self._connect_client()
        server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"

        params: Dict[str, Any] = dict(self.LIBRARY_QUERY_FLAGS)
        params["X-Plex-Container-Start"] = start
        params["X-Plex-Container-Size"] = page_size
        params["includeCollections"] = 1

        path = self._section_path(section_id, "collection")

        try:
            container = client.get_container(path, params=params)
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to load Plex collections for section %s: %s", section_id, exc)
            raise PlexServiceError("Unable to load Plex collections.") from exc

        items = [
            self._serialize_item_overview(item, include_tags=False)
            for item in self._extract_items(container)
        ]
        total_results = self._safe_int(self._value(container, "totalSize"))
        if total_results is None:
            total_results = start + len(items)

        logger.info(
            "Loaded %d Plex collections (section=%s, server=%s, total=%s)",
            len(items),
            section_id,
            server_name,
            total_results,
        )
        return {
            "server": snapshot,
            "section": self._section_entry(container, section_id),
            "items": items,
            "pagination": {
                "offset": start,
                "limit": page_size,
                "total": total_results,
                "size": len(items),
            },
        }

    def search(
        self,
        query: str,
        *,
        offset: int = 0,
        limit: int = 60,
    ) -> Dict[str, Any]:
        """Perform a global Plex search across all library sections."""

        search_term = (query or "").strip()
        if not search_term:
            raise PlexServiceError("A search query is required.")

        offset = max(0, int(offset))
        limit = max(1, min(int(limit), self.MAX_SEARCH_PAGE_SIZE))

        client, snapshot = self._connect_client()
        server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"

        params: Dict[str, Any] = dict(self.LIBRARY_QUERY_FLAGS)
        params["query"] = search_term
        params["X-Plex-Container-Start"] = offset
        params["X-Plex-Container-Size"] = limit

        logger.info(
            "Searching Plex libraries (server=%s, query=%s, offset=%s, limit=%s)",
            server_name,
            search_term,
            offset,
            limit,
        )

        try:
            container = client.get_container("/search", params=params)
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to search Plex libraries for %s: %s", search_term, exc)
            raise PlexServiceError("Unable to search Plex libraries.") from exc

        items = [self._serialize_item_overview(item, include_tags=False) for item in self._extract_items(container)]

        total_results = self._safe_int(self._value(container, "totalSize"))
        if total_results is None:
            total_results = offset + len(items)

        return {
            "server": snapshot,
            "query": search_term,
            "items": items,
            "pagination": {
                "offset": offset,
                "limit": limit,
                "total": total_results,
                "size": len(items),
            },
        }

    def item_details(self, rating_key: Any, *, force_refresh: bool = False) -> Dict[str, Any]:
        """Return detailed metadata (including children) for a Plex item."""

        scope = self._cache_scope()
        cache_key: Optional[str] = None
        if scope:
            cache_key = self._build_cache_key(scope, str(rating_key))
            if not force_refresh:
                cached = self._cache_get(self.METADATA_CACHE_NAMESPACE, cache_key)
                if cached:
                    logger.info(
                        "Serving cached Plex item details (rating_key=%s, scope=%s)",
                        rating_key,
                        scope[:8],
                    )
                    return cached

        client, snapshot = self._connect_client()
        server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"
        logger.info(
            "Fetching Plex item details (rating_key=%s, server=%s)",
            rating_key,
            server_name,
        )

        path = f"/library/metadata/{rating_key}"
        params = dict(self.METADATA_QUERY_FLAGS)
        params["includeChildren"] = 1

        try:
            container = client.get_container(path, params=params)
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to load Plex item %s: %s", rating_key, exc)
            raise PlexServiceError("Plex library item not found.") from exc

        items = self._extract_items(container)
        if not items:
            raise PlexServiceError("Plex library item not found.")

        item = items[0]
        overview = self._serialize_item_overview(item, include_tags=True)
        item_type = overview.get("type")
        response = {
            "server": snapshot,
            "item": overview,
            "media": self._serialize_media(item),
            "children": self._child_overviews(client, rating_key, item_type),
            "related": self._related_hubs(container),
            "images": self._serialize_images(item),
            "extras": self._serialize_extras(item),
            "chapters": self._serialize_chapters(item),
            "markers": self._serialize_markers(item),
            "reviews": self._serialize_reviews(item),
            "preferences": self._serialize_preferences(item),
            "ratings": self._serialize_ratings(item),
            "guids": self._serialize_guids(item),
        }
        colors = self._serialize_ultra_blur(item)
        if colors:
            response["ultra_blur"] = colors

        if cache_key:
            self._cache_set(self.METADATA_CACHE_NAMESPACE, cache_key, response)

        return response

    def refresh_sections(self) -> Dict[str, Any]:
        """Force-refresh the cached section listing."""

        return self.list_sections(force_refresh=True)

    def refresh_section_items(
        self,
        section_id: Any,
        *,
        sort: Optional[str] = None,
        letter: Optional[str] = None,
        search: Optional[str] = None,
        watch_state: Optional[str] = None,
        genre: Optional[str] = None,
        collection: Optional[str] = None,
        year: Optional[str] = None,
        offset: int = 0,
        limit: int = 60,
        snapshot_merge: bool = False,
    ) -> Dict[str, Any]:
        """Fetch a section page bypassing the cache and updating it."""

        return self.section_items(
            section_id,
            sort=sort,
            letter=letter,
            search=search,
            watch_state=watch_state,
            genre=genre,
            collection=collection,
            year=year,
            offset=offset,
            limit=limit,
            force_refresh=True,
            snapshot_merge=snapshot_merge,
        )

    def refresh_item_details(self, rating_key: Any) -> Dict[str, Any]:
        """Refresh the cached payload for a specific Plex item."""

        return self.item_details(rating_key, force_refresh=True)

    def resolve_media_source(self, rating_key: Any, *, part_id: Optional[Any] = None) -> Dict[str, Any]:
        """Resolve a Plex item's media path for transcoding."""

        client, _snapshot = self._connect_client()

        path = f"/library/metadata/{rating_key}"
        params = dict(self.METADATA_QUERY_FLAGS)
        params["includeChildren"] = 0

        try:
            container = client.get_container(path, params=params)
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to resolve Plex media for %s: %s", rating_key, exc)
            raise PlexServiceError("Unable to resolve Plex media source.") from exc

        items = self._extract_items(container)
        if not items:
            raise PlexServiceError("Plex library item not found.")

        item = items[0]
        media_items = self._extract_media_list(item)
        selected_media = None
        selected_part = None
        target_part = str(part_id) if part_id is not None else None

        for medium in media_items:
            parts = self._extract_part_list(medium)
            if target_part:
                for part in parts:
                    if str(self._value(part, "id")) == target_part:
                        selected_media = medium
                        selected_part = part
                        break
            if selected_part:
                break
            if parts:
                selected_media = medium
                selected_part = parts[0]
                break

        if not selected_part:
            raise PlexServiceError("The selected Plex item does not have a playable media part.")

        file_path = self._value(selected_part, "file")
        if not file_path:
            raise PlexServiceError("Media part is missing an accessible file path.")

        item_type = self._value(item, "type")
        media_kind = "audio" if item_type == "track" else "video"

        payload = {
            "item": self._serialize_item_overview(item, include_tags=False),
            "file": file_path,
            "media_type": media_kind,
            "part_id": self._value(selected_part, "id"),
            "container": self._value(selected_part, "container"),
            "duration": self._value(selected_part, "duration"),
            "video_codec": self._value(selected_media, "videoCodec") if selected_media else None,
            "audio_codec": self._value(selected_media, "audioCodec") if selected_media else None,
        }
        logger.info(
            "Resolved Plex media source (rating_key=%s, part_id=%s, media_type=%s, path=%s)",
            rating_key,
            target_part or self._value(selected_part, "id"),
            media_kind,
            file_path,
        )
        return payload

    def fetch_image(self, path: str, params: Optional[Dict[str, Any]] = None) -> "PlexImageResponse":
        """Fetch an image or art asset from Plex for proxying, with local caching."""

        if not path or not isinstance(path, str):
            raise PlexServiceError("Invalid Plex image path.")

        trimmed = path.strip()
        normalized = trimmed if trimmed.startswith(("http://", "https://", "/")) else f"/{trimmed}"

        request_params = dict(params or {})
        variant = self._normalize_image_variant(request_params.pop("variant", None))
        forwarded_params = dict(request_params)
        skip_grid_variant = self._is_art_image(normalized, forwarded_params)

        original_cache_paths = self._prepare_image_cache_paths(
            normalized,
            forwarded_params,
            variant=self.IMAGE_VARIANT_ORIGINAL,
        )
        grid_cache_paths: Optional[_ImageCachePaths] = None
        if not skip_grid_variant:
            grid_cache_paths = self._prepare_image_cache_paths(
                normalized,
                forwarded_params,
                variant=self.IMAGE_VARIANT_GRID,
            )

        include_token = "X-Plex-Token=" not in normalized

        if variant == self.IMAGE_VARIANT_GRID:
            if skip_grid_variant:
                variant = self.IMAGE_VARIANT_ORIGINAL
            else:
                logger.debug(
                    "Serving Plex grid thumbnail request (path=%s, params=%s)",
                    normalized,
                    forwarded_params,
                )
            return self._serve_grid_image(
                normalized,
                forwarded_params,
                include_token=include_token,
                original_cache_paths=original_cache_paths,
                grid_cache_paths=grid_cache_paths,
            )

        cache_paths = original_cache_paths
        cached = self._load_cached_image(cache_paths)
        if cached is not None:
            logger.info(
                "Serving cached Plex image (path=%s, params=%s)",
                normalized,
                forwarded_params,
            )
            if not skip_grid_variant:
                self._ensure_grid_thumbnail(cache_paths, grid_cache_paths)
            return cached

        client, _snapshot = self._connect_client()

        try:
            response = client.get(
                normalized,
                params=forwarded_params,
                parse=False,
                stream=True,
                include_token=include_token,
            )
        except Exception as exc:  # pragma: no cover - depends on network
            logger.exception("Failed to proxy Plex image %s: %s", normalized, exc)
            raise PlexServiceError("Unable to fetch Plex image.") from exc

        headers = self._filter_image_headers(response.headers)
        headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)

        post_finalize: Optional[Callable[[
            _ImageCachePaths,
            Dict[str, str],
            int,
        ], None]] = None

        if cache_paths is not None and grid_cache_paths is not None:

            def _post_finalize(
                cached_paths: _ImageCachePaths,
                header_values: Dict[str, str],
                status_code: int,
            ) -> None:
                try:
                    if not skip_grid_variant:
                        self._ensure_grid_thumbnail(
                            cached_paths,
                            grid_cache_paths,
                            base_headers=header_values,
                            status_code=status_code,
                        )
                except Exception as exc_inner:  # pragma: no cover - defensive logging
                    logger.warning(
                        "Failed to create Plex grid thumbnail for %s: %s",
                        cached_paths.data_path,
                        exc_inner,
                    )

            post_finalize = _post_finalize

        proxy_response = _UpstreamImageResponse(
            response=response,
            headers=headers,
            cache_paths=cache_paths,
            default_cache_control=self.DEFAULT_CACHE_CONTROL,
            post_finalize=post_finalize,
        )

        logger.info(
            "Proxying Plex image request (path=%s, params=%s, cache=%s, status=%s)",
            normalized,
            forwarded_params,
            proxy_response.cache_status,
            proxy_response.status_code,
        )
        return proxy_response

    def _prepare_image_cache_paths(
        self,
        normalized: str,
        params: Optional[Dict[str, Any]],
        *,
        variant: str = IMAGE_VARIANT_ORIGINAL,
    ) -> Optional[_ImageCachePaths]:
        if not self._image_cache_dir:
            return None

        canonical = self._build_image_cache_canonical(normalized, params)
        variant_key = variant if variant else self.IMAGE_VARIANT_ORIGINAL
        if variant_key != self.IMAGE_VARIANT_ORIGINAL:
            canonical = f"{canonical}#variant={variant_key}"
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        data_path = self._image_cache_dir / f"{digest}.bin"
        metadata_path = self._image_cache_dir / f"{digest}.json"
        return _ImageCachePaths(
            canonical=canonical,
            data_path=data_path,
            metadata_path=metadata_path,
            variant=variant_key,
        )

    def _build_image_cache_canonical(
        self,
        path: str,
        params: Optional[Dict[str, Any]],
    ) -> str:
        base, _, query = path.partition("?")
        entries: List[Tuple[str, str]] = []

        if query:
            for key, value in parse_qsl(query, keep_blank_values=True):
                if key.lower() == "x-plex-token":
                    continue
                entries.append((key, value))

        if params:
            for key, value in params.items():
                if value is None or key.lower() == "x-plex-token":
                    continue
                if isinstance(value, (list, tuple)):
                    for entry in value:
                        if entry is None:
                            continue
                        entries.append((key, str(entry)))
                else:
                    entries.append((key, str(value)))

        entries.sort()
        canonical_query = urlencode(entries, doseq=True)
        return f"{base}?{canonical_query}" if canonical_query else base

    def _load_cached_image(self, cache_paths: Optional[_ImageCachePaths]) -> Optional["PlexImageResponse"]:
        if cache_paths is None:
            return None

        data_path = cache_paths.data_path
        if not data_path.exists() or not data_path.is_file():
            return None

        headers: Dict[str, str] = {}
        status_code = 200

        metadata = self._read_cached_image_metadata(cache_paths)

        if isinstance(metadata, dict):
            stored_headers = metadata.get("headers")
            if isinstance(stored_headers, dict):
                headers.update({key: str(value) for key, value in stored_headers.items() if value is not None})
            raw_status = metadata.get("status_code")
            try:
                if raw_status is not None:
                    status_code = int(raw_status)
            except (TypeError, ValueError):
                status_code = 200

        if "Content-Length" not in headers:
            try:
                headers["Content-Length"] = str(data_path.stat().st_size)
            except OSError:
                pass

        headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)

        return _CachedImageResponse(data_path=data_path, headers=headers, status_code=status_code)

    def _read_cached_image_metadata(self, cache_paths: Optional[_ImageCachePaths]) -> Dict[str, Any]:
        if cache_paths is None:
            return {}
        try:
            with cache_paths.metadata_path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            return {}
        except Exception as exc:  # pragma: no cover - best effort logging only
            logger.warning(
                "Failed to read cached Plex image metadata (%s): %s",
                cache_paths.metadata_path,
                exc,
            )
            return {}
        return payload if isinstance(payload, dict) else {}

    def _normalize_image_params(self, params: Optional[Mapping[str, Any]]) -> Dict[str, str]:
        normalized: Dict[str, str] = {}
        if not params:
            return normalized
        for key, value in params.items():
            if value is None:
                continue
            normalized[str(key)] = str(value)
        return normalized

    def _is_art_image(self, path: str, params: Optional[Mapping[str, Any]] = None) -> bool:
        normalized_path = path.lower()
        if "/art/" in normalized_path or normalized_path.endswith("/art"):
            return True
        if params:
            for key, value in params.items():
                key_lower = str(key).lower()
                value_lower = str(value).lower()
                if key_lower in {"type", "image", "style"} and value_lower == "art":
                    return True
        return False

    def _normalize_image_variant(self, raw: Any) -> str:
        if raw is None:
            return self.IMAGE_VARIANT_ORIGINAL
        candidate = str(raw).strip().lower()
        if candidate == self.IMAGE_VARIANT_GRID:
            return self.IMAGE_VARIANT_GRID
        return self.IMAGE_VARIANT_ORIGINAL

    def _write_image_cache(
        self,
        cache_paths: Optional[_ImageCachePaths],
        payload: bytes,
        headers: Mapping[str, Any],
        status_code: int,
        *,
        extra_metadata: Optional[Mapping[str, Any]] = None,
    ) -> None:
        if cache_paths is None or not payload:
            return

        unique_token = uuid.uuid4().hex
        temp_path = cache_paths.data_path.parent / f"{cache_paths.data_path.name}.{unique_token}.tmp"
        temp_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with temp_path.open("wb") as handle:
                handle.write(payload)
            os.replace(temp_path, cache_paths.data_path)
        except OSError as exc:  # pragma: no cover - depends on filesystem state
            logger.warning(
                "Failed to store Plex image cache (%s): %s",
                cache_paths.data_path,
                exc,
            )
            try:
                temp_path.unlink()
            except OSError:
                pass
            return

        metadata_headers = {
            key: str(value)
            for key, value in dict(headers or {}).items()
            if value is not None
        }
        metadata_headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)
        metadata_headers["Content-Length"] = str(len(payload))

        metadata_payload: Dict[str, Any] = {
            "headers": metadata_headers,
            "status_code": int(status_code),
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "canonical": cache_paths.canonical,
            "variant": cache_paths.variant,
        }
        if extra_metadata:
            metadata_payload.update(extra_metadata)

        try:
            cache_paths.metadata_path.parent.mkdir(parents=True, exist_ok=True)
            with cache_paths.metadata_path.open("w", encoding="utf-8") as handle:
                json.dump(metadata_payload, handle)
        except Exception as exc:  # pragma: no cover - best effort logging only
            logger.warning(
                "Failed to write Plex image cache metadata (%s): %s",
                cache_paths.metadata_path,
                exc,
            )

    def _generate_grid_thumbnail_payload(
        self,
        *,
        source_path: Optional[Path] = None,
        source_bytes: Optional[bytes] = None,
    ) -> Optional[bytes]:
        image_source: Any
        if source_path is not None:
            image_source = source_path
        elif source_bytes:
            image_source = BytesIO(source_bytes)
        else:
            return None

        try:
            width, height, quality = self._thumbnail_config()
            with Image.open(image_source) as image:
                image.load()
                if image.mode not in {"RGB", "L"}:
                    image = image.convert("RGB")
                elif image.mode == "L":
                    image = image.convert("RGB")
                resample_space = getattr(Image, "Resampling", Image)
                resample_filter = getattr(resample_space, "LANCZOS", getattr(Image, "LANCZOS", Image.BICUBIC))
                image.thumbnail((width, height), resample=resample_filter)
                buffer = BytesIO()
                image.save(
                    buffer,
                    format="JPEG",
                    quality=quality,
                    optimize=True,
                    progressive=True,
                )
                return buffer.getvalue()
        except Exception as exc:  # pragma: no cover - best effort logging only
            logger.warning(
                "Failed to generate Plex grid thumbnail (%s): %s",
                source_path or "memory-stream",
                exc,
            )
            return None

    def _ensure_grid_thumbnail(
        self,
        source_paths: Optional[_ImageCachePaths],
        grid_paths: Optional[_ImageCachePaths],
        *,
        base_headers: Optional[Mapping[str, Any]] = None,
        status_code: Optional[int] = None,
        force: bool = False,
    ) -> None:
        if not source_paths or not grid_paths:
            return

        if force:
            for existing in (grid_paths.data_path, grid_paths.metadata_path):
                try:
                    if existing.exists():
                        existing.unlink()
                except OSError:
                    pass
        elif grid_paths.data_path.exists() and grid_paths.metadata_path.exists():
            return

        if not source_paths.data_path.exists():
            return

        payload = self._generate_grid_thumbnail_payload(source_path=source_paths.data_path)
        if not payload:
            return

        headers = {
            key: str(value)
            for key, value in dict(base_headers or {}).items()
            if value is not None
        }
        for header in ("Content-Length", "ETag", "Last-Modified", "Expires"):
            headers.pop(header, None)
        headers["Content-Type"] = "image/jpeg"
        headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)

        self._write_image_cache(
            grid_paths,
            payload,
            headers,
            status_code or 200,
            extra_metadata={
                "source_canonical": source_paths.canonical,
            },
        )

    def _serve_grid_image(
        self,
        normalized: str,
        params: Dict[str, Any],
        *,
        include_token: bool,
        original_cache_paths: Optional[_ImageCachePaths],
        grid_cache_paths: Optional[_ImageCachePaths],
    ) -> "PlexImageResponse":
        if self._is_art_image(normalized, params):
            payload = self._fetch_upstream_image_payload(
                normalized,
                params,
                include_token=include_token,
            )
            headers = dict(payload.headers)
            headers["Content-Length"] = str(len(payload.payload))
            return _MemoryImageResponse(
                payload=payload.payload,
                headers=headers,
                status_code=payload.status_code,
                cache_status="bypass",
            )
        if grid_cache_paths is None:
            client_payload = self._fetch_upstream_image_payload(
                normalized,
                params,
                include_token=include_token,
            )
            return self._build_memory_grid_response(client_payload)

        cached = self._load_cached_image(grid_cache_paths)
        if cached is not None:
            return cached

        self._ensure_grid_thumbnail(original_cache_paths, grid_cache_paths)
        cached = self._load_cached_image(grid_cache_paths)
        if cached is not None:
            return cached

        client_payload = self._fetch_upstream_image_payload(
            normalized,
            params,
            include_token=include_token,
        )

        if original_cache_paths is not None and client_payload.payload:
            self._write_image_cache(
                original_cache_paths,
                client_payload.payload,
                client_payload.headers,
                client_payload.status_code,
            )

        self._ensure_grid_thumbnail(
            original_cache_paths,
            grid_cache_paths,
            base_headers=client_payload.headers,
            status_code=client_payload.status_code,
        )

        cached = self._load_cached_image(grid_cache_paths)
        if cached is not None:
            return cached

        return self._build_memory_grid_response(client_payload)

    def _fetch_upstream_image_payload(
        self,
        normalized: str,
        params: Dict[str, Any],
        *,
        include_token: bool,
    ) -> _FetchedImagePayload:
        client, _snapshot = self._connect_client()
        try:
            response = client.get(
                normalized,
                params=params,
                parse=False,
                stream=False,
                include_token=include_token,
            )
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover - depends on network state
            logger.exception("Failed to proxy Plex image %s: %s", normalized, exc)
            raise PlexServiceError("Unable to fetch Plex image.") from exc

        try:
            headers = self._filter_image_headers(response.headers)
            headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)
            payload = response.content or b""
            status_code = response.status_code
        finally:
            response.close()

        return _FetchedImagePayload(payload=payload, headers=headers, status_code=status_code)

    def _build_memory_grid_response(self, client_payload: _FetchedImagePayload) -> "PlexImageResponse":
        thumbnail_payload = self._generate_grid_thumbnail_payload(
            source_bytes=client_payload.payload
        )
        headers = dict(client_payload.headers)
        if thumbnail_payload:
            headers.pop("Content-Length", None)
            headers["Content-Type"] = "image/jpeg"
            headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)
            headers["Content-Length"] = str(len(thumbnail_payload))
            return _MemoryImageResponse(
                payload=thumbnail_payload,
                headers=headers,
                status_code=client_payload.status_code,
                cache_status="bypass",
            )

        headers["Content-Length"] = str(len(client_payload.payload))
        return _MemoryImageResponse(
            payload=client_payload.payload,
            headers=headers,
            status_code=client_payload.status_code,
            cache_status="bypass",
        )

    def _precache_image(
        self,
        path: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        ensure_grid: bool = True,
        force: bool = False,
    ) -> Dict[str, Any]:
        if not path or not isinstance(path, str):
            raise PlexServiceError("Invalid Plex image path.")

        trimmed = path.strip()
        normalized = trimmed if trimmed.startswith(("http://", "https://", "/")) else f"/{trimmed}"
        normalized_params = self._normalize_image_params(params)

        cache_paths = self._prepare_image_cache_paths(
            normalized,
            normalized_params,
            variant=self.IMAGE_VARIANT_ORIGINAL,
        )
        if cache_paths is None:
            raise PlexServiceError("Image caching is not enabled.")

        grid_paths: Optional[_ImageCachePaths] = None
        should_cache_grid = ensure_grid and not self._is_art_image(normalized, normalized_params)
        if should_cache_grid:
            grid_paths = self._prepare_image_cache_paths(
                normalized,
                normalized_params,
                variant=self.IMAGE_VARIANT_GRID,
            )
            if grid_paths is None:
                raise PlexServiceError("Image caching is not enabled.")

        data_exists = cache_paths.data_path.exists()
        metadata_exists = cache_paths.metadata_path.exists()
        original_present = data_exists and metadata_exists

        include_token = "X-Plex-Token=" not in normalized

        payload_headers: Optional[Dict[str, str]] = None
        status_code_value: Optional[int] = None
        fetched = False

        if force or not original_present:
            payload = self._fetch_upstream_image_payload(
                normalized,
                dict(normalized_params),
                include_token=include_token,
            )
            if not payload.payload:
                raise PlexServiceError("Plex returned an empty image payload.")
            self._write_image_cache(
                cache_paths,
                payload.payload,
                payload.headers,
                payload.status_code,
            )
            try:
                size_on_disk = cache_paths.data_path.stat().st_size if cache_paths.data_path.exists() else "unknown"
            except OSError:
                size_on_disk = "unknown"
            logger.info(
                "Cached Plex image variant (path=%s, variant=%s, status=%s, size=%s)",
                normalized,
                self.IMAGE_VARIANT_ORIGINAL,
                payload.status_code,
                size_on_disk,
            )
            payload_headers = dict(payload.headers)
            status_code_value = int(payload.status_code)
            fetched = True
        else:
            metadata = self._read_cached_image_metadata(cache_paths)
            stored_headers = metadata.get("headers") if isinstance(metadata, dict) else None
            if isinstance(stored_headers, Mapping):
                payload_headers = {
                    str(key): str(value)
                    for key, value in stored_headers.items()
                    if value is not None
                }
            raw_status = metadata.get("status_code") if isinstance(metadata, dict) else None
            try:
                status_code_value = int(raw_status) if raw_status is not None else None
            except (TypeError, ValueError):
                status_code_value = None

        grid_created = False
        if should_cache_grid and grid_paths is not None:
            grid_exists = grid_paths.data_path.exists() and grid_paths.metadata_path.exists()
            if force or not grid_exists:
                before_exists = grid_paths.data_path.exists()
                self._ensure_grid_thumbnail(
                    cache_paths,
                    grid_paths,
                    base_headers=payload_headers or {},
                    status_code=status_code_value or 200,
                    force=force,
                )
                after_exists = grid_paths.data_path.exists()
                grid_created = after_exists and not before_exists
                if grid_created:
                    try:
                        grid_size = grid_paths.data_path.stat().st_size if grid_paths.data_path.exists() else "unknown"
                    except OSError:
                        grid_size = "unknown"
                    logger.info(
                        "Cached Plex image variant (path=%s, variant=%s, status=%s, size=%s)",
                        normalized,
                        self.IMAGE_VARIANT_GRID,
                        status_code_value or 200,
                        grid_size,
                    )

        return {
            "path": normalized,
            "fetched": fetched,
            "skipped": not fetched,
            "grid_created": grid_created,
        }

    def _filter_image_headers(self, headers: Any) -> Dict[str, str]:
        filtered: Dict[str, str] = {}
        for header in self.IMAGE_HEADER_WHITELIST:
            try:
                value = headers.get(header)  # type: ignore[call-arg]
            except AttributeError:  # pragma: no cover - defensive
                value = None
            if value:
                filtered[header] = value
        return filtered

    def _collect_item_image_paths(self, item: Mapping[str, Any]) -> List[str]:
        paths: List[str] = []
        if not isinstance(item, Mapping):
            return paths

        seen: set[str] = set()

        def _append(candidate: Any) -> None:
            if not candidate:
                return
            value = str(candidate).strip()
            if not value or value in seen:
                return
            seen.add(value)
            paths.append(value)

        _append(item.get("thumb"))
        _append(item.get("grandparent_thumb"))
        _append(item.get("art"))

        return paths

    # ------------------------------------------------------------------
    # Internal helpers

    def _build_headers(self) -> Dict[str, str]:
        headers = {
            "Accept": "application/json",
            "X-Plex-Accept": "application/json",
            "X-Plex-Client-Identifier": self._client_identifier,
            "X-Plex-Product": self._product,
            "X-Plex-Device": self._device_name,
            "X-Plex-Device-Name": self._device_name,
            "X-Plex-Platform": self._platform,
            "X-Plex-Version": self._version,
            "X-Plex-Platform-Version": "1.0",
        }
        headers.setdefault("User-Agent", f"{self._product}/{self._version}")
        return headers

    def _update_settings(self, values: Dict[str, Any]) -> None:
        for key, value in values.items():
            self._settings.set_system_setting(SettingsService.PLEX_NAMESPACE, key, value)

    def _get_token(self) -> str:
        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        token = settings.get("auth_token")
        if not token:
            raise PlexNotConnectedError("Plex account is not connected.")
        return str(token)

    def _create_client(self, *, base_url: str, token: str, verify_ssl: bool) -> PlexClient:
        headers = self._build_headers()
        return PlexClient(
            base_url,
            token,
            headers,
            timeout=self._request_timeout,
            verify=verify_ssl,
        )

    def _build_client(self, base_url: str, token: str, verify_ssl: bool) -> Tuple[PlexClient, bool]:
        if verify_ssl:
            return self._create_client(base_url=base_url, token=token, verify_ssl=True), True
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", InsecureRequestWarning)
            client = self._create_client(base_url=base_url, token=token, verify_ssl=False)
        return client, False

    def _load_account_snapshot(self, client: PlexClient) -> Optional[Dict[str, Any]]:
        headers = client.headers
        headers = dict(headers)
        headers["X-Plex-Token"] = client.token
        headers["Accept"] = "application/json"
        try:
            response = requests.get(
                self.ACCOUNT_RESOURCE_URL,
                headers=headers,
                timeout=self._request_timeout,
            )
            if response.status_code >= 400:
                logger.debug(
                    "Unable to fetch Plex account details (status=%s)",
                    response.status_code,
                )
                return None
            data = response.json()
        except requests.RequestException as exc:  # pragma: no cover - network errors
            logger.debug("Unable to fetch Plex account details: %s", exc)
            return None
        except json.JSONDecodeError:  # pragma: no cover - invalid JSON
            logger.debug("Received invalid JSON while fetching Plex account details")
            return None
        return self._serialize_account(data)

    def _connect_client(self, *, force_refresh: bool = False) -> Tuple[PlexClient, Dict[str, Any]]:
        base_url = self._get_server_base_url()
        token = self._get_token()
        verify_ssl = self._get_verify_ssl()

        if not force_refresh:
            cached = self._get_cached_client(base_url=base_url, token=token, verify_ssl=verify_ssl)
            if cached:
                return cached

        try:
            client, actual_verify = self._build_client(base_url, token, verify_ssl)
            identity = client.get_container("/identity")
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to connect to Plex server using stored configuration: %s", exc)
            self._invalidate_cached_client()
            raise PlexServiceError("Unable to connect to the stored Plex server.") from exc

        snapshot = self._build_snapshot(identity, base_url=base_url, verify_ssl=actual_verify)
        updates: Dict[str, Any] = {
            "server": snapshot,
            "last_connected_at": datetime.now(timezone.utc).isoformat(),
        }
        if actual_verify != verify_ssl:
            updates["verify_ssl"] = actual_verify

        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        if self._allow_account_lookup and not settings.get("account"):
            account_info = self._load_account_snapshot(client)
            if account_info is not None:
                updates["account"] = account_info

        self._update_settings(updates)
        self._store_cached_client(
            client=client,
            snapshot=snapshot,
            base_url=base_url,
            token=token,
            verify_ssl=actual_verify,
        )
        return client, snapshot

    def _get_server_base_url(self) -> str:
        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        base_url = settings.get("server_base_url") or self._server_base_url
        if not base_url:
            raise PlexNotConnectedError("Plex server host is not configured.")
        return self._normalize_server_url(base_url)

    def _get_verify_ssl(self) -> bool:
        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        verify = settings.get("verify_ssl")
        if isinstance(verify, bool):
            return verify
        return True

    def _normalize_server_url(self, raw: str) -> str:
        candidate = str(raw or "").strip()
        if not candidate:
            raise PlexServiceError("A Plex server host or URL must be provided.")
        if "://" not in candidate:
            candidate = f"http://{candidate}"
        parsed = urlparse(candidate)
        if not parsed.scheme or not parsed.netloc:
            raise PlexServiceError("Invalid Plex server URL provided.")
        normalized = f"{parsed.scheme}://{parsed.netloc}"
        if parsed.path and parsed.path != "/":
            normalized += parsed.path.rstrip("/")
        return normalized

    def _build_snapshot(
        self,
        identity: Dict[str, Any],
        *,
        base_url: Optional[str] = None,
        verify_ssl: Optional[bool] = None,
    ) -> Dict[str, Any]:
        friendly_name = self._value(identity, "friendlyName") or self._value(identity, "name")
        machine_identifier = self._value(identity, "machineIdentifier")
        platform = self._value(identity, "platform")
        platform_version = self._value(identity, "platformVersion")
        product = self._value(identity, "product")
        device = self._value(identity, "device")
        device_name = self._value(identity, "deviceName")
        version = self._value(identity, "version")
        size = self._value(identity, "size")

        normalized = (base_url or "").strip().rstrip("/")
        connections: List[Dict[str, Any]] = []
        if normalized:
            parsed = urlparse(normalized)
            host = parsed.hostname
            port = parsed.port
            is_local = False
            if host:
                try:
                    is_local = ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback
                except ValueError:
                    is_local = host in {"localhost"}
            connections.append({
                "uri": normalized,
                "address": host,
                "port": port,
                "local": is_local,
                "relay": False,
                "public": False if is_local else bool(host and not is_local),
                "protocol": parsed.scheme,
                "dns": host,
                "verify_ssl": verify_ssl if verify_ssl is not None else None,
            })

        snapshot = {
            "name": friendly_name,
            "size": self._safe_int(size),
            "machine_identifier": machine_identifier,
            "version": version,
            "platform": platform,
            "platform_version": platform_version,
            "product": product,
            "device": device,
            "device_name": device_name,
            "base_url": normalized,
            "connections": connections,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "verify_ssl": verify_ssl,
            "has_plex_pass": None,
        }
        return snapshot

    @staticmethod
    def _safe_int(value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return None
        return None

    @staticmethod
    def _as_bool(value: Any) -> Optional[bool]:
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"", "0", "false", "no"}:
                return False
            if lowered in {"1", "true", "yes"}:
                return True
        return bool(value)

    def _value(self, obj: Any, attr: str, default: Any = None) -> Any:
        if obj is None:
            return default
        if isinstance(obj, dict):
            attr_key = f"@{attr}"
            if attr_key in obj:
                return obj[attr_key]
            if attr in obj:
                return obj[attr]
            alt = attr[:1].upper() + attr[1:]
            if alt in obj:
                return obj[alt]
            return default
        return getattr(obj, attr, default)

    def _ensure_list(self, value: Any) -> List[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        return [value]

    def _isoformat(self, value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.isoformat()
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return None
            try:
                return datetime.fromtimestamp(float(raw), tz=timezone.utc).isoformat()
            except ValueError:
                try:
                    parsed = datetime.fromisoformat(raw)
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    return parsed.isoformat()
                except ValueError:
                    return raw
        return None

    def _extract_items(self, container: Dict[str, Any]) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for key in ("Metadata", "Video", "Directory", "Photo", "Track", "Album", "Artist"):
            entries = container.get(key)
            if entries is None:
                continue
            items.extend(self._ensure_list(entries))
        return items

    def _extract_media_list(self, item: Any) -> List[Any]:
        media = self._value(item, "media")
        if media is None and isinstance(item, dict):
            media = item.get("Media")
        return self._ensure_list(media)

    def _extract_part_list(self, media: Any) -> List[Any]:
        parts = self._value(media, "parts")
        if parts is None and isinstance(media, dict):
            parts = media.get("Part") or media.get("part")
        return self._ensure_list(parts)

    def _extract_stream_list(self, part: Any) -> List[Any]:
        streams = self._value(part, "streams")
        if streams is None and isinstance(part, dict):
            streams = part.get("Stream") or part.get("stream")
        return self._ensure_list(streams)

    def _section_path(self, section_id: Any, suffix: str = "all") -> str:
        if section_id is None:
            raise PlexServiceError("A Plex section identifier is required.")
        candidate = str(section_id).strip()
        if candidate.isdigit():
            base = f"/library/sections/{candidate.strip()}"
        elif candidate.startswith("/library/sections/"):
            base = candidate.rstrip("/")
        else:
            base = f"/library/sections/{candidate.strip('/')}"
        return f"{base}/{suffix}" if suffix else base

    def _section_entry(self, container: Dict[str, Any], section_id: Any) -> Optional[Dict[str, Any]]:
        directory = container.get("Directory")
        if directory:
            try:
                return self._serialize_section(self._ensure_list(directory)[0])
            except Exception:  # pragma: no cover - defensive
                pass
        return {"id": section_id}

    @staticmethod
    def _compose_section_identifier(
        section_id: Optional[int],
        uuid: Optional[str],
        key: Optional[str],
    ) -> Optional[str]:
        if section_id is not None:
            return str(section_id)
        if uuid:
            return str(uuid).strip()
        if key:
            return str(key).strip("/")
        return None

    def _serialize_section(self, section: Any) -> Dict[str, Any]:
        key = self._value(section, "key")
        section_id: Optional[int] = None
        if key is not None:
            try:
                section_id = int(str(key).strip("/").split("/")[-1])
            except (ValueError, TypeError):  # pragma: no cover - defensive parsing
                section_id = None
        uuid = self._value(section, "uuid")
        title = self._value(section, "title")
        section_type = self._value(section, "type")
        language = self._value(section, "language")
        agent = self._value(section, "agent")
        scanner = self._value(section, "scanner")
        created_at = self._isoformat(self._value(section, "createdAt"))
        updated_at = self._isoformat(self._value(section, "updatedAt"))
        thumb = self._value(section, "thumb")
        art = self._value(section, "art")
        size = (
            self._safe_int(self._value(section, "size"))
            or self._safe_int(self._value(section, "totalSize"))
            or self._safe_int(self._value(section, "count"))
        )

        identifier = self._compose_section_identifier(section_id, uuid, key)

        return {
            "id": section_id,
            "key": key,
            "uuid": uuid,
            "title": title,
            "type": section_type,
            "language": language,
            "agent": agent,
            "scanner": scanner,
            "created_at": created_at,
            "updated_at": updated_at,
            "thumb": thumb,
            "art": art,
            "size": size,
            "identifier": identifier,
        }

    def _serialize_item_overview(self, item: Any, *, include_tags: bool = True) -> Dict[str, Any]:
        rating_key = self._value(item, "ratingKey")
        item_type = self._value(item, "type")
        data = {
            "rating_key": str(rating_key) if rating_key is not None else None,
            "key": self._value(item, "key"),
            "type": item_type,
            "title": self._value(item, "title"),
            "sort_title": self._value(item, "titleSort"),
            "slug": self._value(item, "slug"),
            "summary": self._value(item, "summary"),
            "tagline": self._value(item, "tagline"),
            "year": self._value(item, "year"),
            "index": self._value(item, "index"),
            "parent_index": self._value(item, "parentIndex"),
            "grandparent_title": self._value(item, "grandparentTitle"),
            "parent_title": self._value(item, "parentTitle"),
            "grandparent_rating_key": self._value(item, "grandparentRatingKey"),
            "parent_rating_key": self._value(item, "parentRatingKey"),
            "leaf_count": self._value(item, "leafCount"),
            "child_count": self._value(item, "childCount"),
            "duration": self._value(item, "duration"),
            "originally_available_at": self._value(item, "originallyAvailableAt"),
            "added_at": self._isoformat(self._value(item, "addedAt")),
            "updated_at": self._isoformat(self._value(item, "updatedAt")),
            "last_viewed_at": self._isoformat(self._value(item, "lastViewedAt")),
            "view_count": self._value(item, "viewCount"),
            "thumb": self._value(item, "thumb") or self._value(item, "grandparentThumb"),
            "grandparent_thumb": self._value(item, "grandparentThumb"),
            "art": self._value(item, "art") or self._value(item, "grandparentArt"),
            "guid": self._value(item, "guid"),
            "content_rating": self._value(item, "contentRating"),
            "studio": self._value(item, "studio"),
            "rating": self._value(item, "rating"),
            "audience_rating": self._value(item, "audienceRating"),
            "user_rating": self._value(item, "userRating"),
            "original_title": self._value(item, "originalTitle"),
            "library_section_id": self._value(item, "librarySectionID"),
            "library_section_title": self._value(item, "librarySectionTitle"),
            "library_section_key": self._value(item, "librarySectionKey"),
            "library_section_uuid": self._value(item, "librarySectionUUID"),
            "primary_extra_key": self._value(item, "primaryExtraKey"),
            "rating_image": self._value(item, "ratingImage"),
            "audience_rating_image": self._value(item, "audienceRatingImage"),
            "playable": bool(item_type) and item_type in self.PLAYABLE_TYPES,
        }

        if include_tags:
            data.update(
                {
                    "genres": self._tag_entries(item, "genres", "genre"),
                    "collections": self._tag_entries(item, "collections", "collection"),
                    "writers": self._tag_entries(item, "writers", "writer"),
                    "directors": self._tag_entries(item, "directors", "director"),
                    "actors": self._tag_entries(item, "actors", "roles", "role", "actor"),
                    "producers": self._tag_entries(item, "producers", "producer"),
                    "labels": self._tag_entries(item, "labels", "label"),
                    "moods": self._tag_entries(item, "moods", "mood"),
                    "styles": self._tag_entries(item, "styles", "style"),
                    "countries": self._tag_entries(item, "countries", "country"),
                }
            )

        if item_type in {"track", "album", "artist"}:
            data.update(
                {
                    "album": self._value(item, "parentTitle"),
                    "artist": self._value(item, "grandparentTitle") or self._value(item, "parentTitle"),
                    "album_rating_key": self._value(item, "parentRatingKey"),
                    "artist_rating_key": self._value(item, "grandparentRatingKey"),
                }
            )

        if item_type in {"episode", "season", "show"}:
            data.update(
                {
                    "show_title": self._value(item, "grandparentTitle") or self._value(item, "parentTitle"),
                    "season_title": self._value(item, "parentTitle"),
                    "season_number": self._value(item, "parentIndex"),
                    "episode_number": self._value(item, "index"),
                }
            )

        return data

    def _tag_list(self, tags: Any) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for tag in self._ensure_list(tags):
            label = self._value(tag, "tag")
            if not label:
                continue
            items.append({
                "id": self._value(tag, "id"),
                "tag": label,
                "title": self._value(tag, "title") or label,
                "thumb": self._value(tag, "thumb"),
                "role": self._value(tag, "role"),
            })
        return items

    def _tag_entries(self, item: Any, *keys: str) -> List[Dict[str, Any]]:
        for key in keys:
            tags = self._value(item, key)
            if tags:
                return self._tag_list(tags)
        return []

    def _serialize_streams(self, streams: Iterable[Any]) -> List[Dict[str, Any]]:
        payload: List[Dict[str, Any]] = []
        if not streams:
            return payload
        for stream in streams:
            payload.append({
                "id": self._value(stream, "id"),
                "index": self._value(stream, "index"),
                "stream_type": self._value(stream, "streamType"),
                "type": self._value(stream, "type"),
                "codec": self._value(stream, "codec") or self._value(stream, "codecName"),
                "codec_id": self._value(stream, "codecID"),
                "language": self._value(stream, "language") or self._value(stream, "languageCode"),
                "channels": self._value(stream, "channels"),
                "profile": self._value(stream, "profile"),
                "bitrate": self._value(stream, "bitrate"),
                "sampling_rate": self._value(stream, "samplingRate"),
                "width": self._value(stream, "width"),
                "height": self._value(stream, "height"),
                "frame_rate": self._value(stream, "frameRate"),
                "color_space": self._value(stream, "colorSpace"),
                "default": self._value(stream, "default"),
                "forced": self._value(stream, "forced"),
                "title": self._value(stream, "title"),
                "display_title": self._value(stream, "displayTitle"),
            })
        return payload

    def _serialize_media_part(self, part: Any) -> Dict[str, Any]:
        return {
            "id": self._value(part, "id"),
            "key": self._value(part, "key"),
            "file": self._value(part, "file"),
            "duration": self._value(part, "duration"),
            "size": self._value(part, "size"),
            "container": self._value(part, "container"),
            "optimized_for_streaming": self._value(part, "optimizedForStreaming"),
            "has64bit_offsets": self._value(part, "has64bitOffsets"),
            "indexes": self._value(part, "indexes"),
            "streams": self._serialize_streams(self._extract_stream_list(part)),
        }

    def _serialize_media(self, item: Any) -> List[Dict[str, Any]]:
        payload: List[Dict[str, Any]] = []
        media_items = self._extract_media_list(item)
        if not media_items:
            return payload
        for medium in media_items:
            parts = [self._serialize_media_part(part) for part in self._extract_part_list(medium)]
            payload.append({
                "id": self._value(medium, "id"),
                "duration": self._value(medium, "duration"),
                "bitrate": self._value(medium, "bitrate"),
                "width": self._value(medium, "width"),
                "height": self._value(medium, "height"),
                "aspect_ratio": self._value(medium, "aspectRatio"),
                "audio_channels": self._value(medium, "audioChannels"),
                "audio_codec": self._value(medium, "audioCodec"),
                "video_codec": self._value(medium, "videoCodec"),
                "video_resolution": self._value(medium, "videoResolution"),
                "container": self._value(medium, "container"),
                "parts": parts,
            })
        return payload

    def _child_overviews(self, client: PlexClient, rating_key: Any, item_type: Optional[str]) -> Dict[str, List[Dict[str, Any]]]:
        children: Dict[str, List[Dict[str, Any]]] = {}
        if item_type not in {"show", "season", "artist", "album", "collection"}:
            return children

        path = f"/library/metadata/{rating_key}/children"
        params = dict(self.LIBRARY_QUERY_FLAGS)
        try:
            container = client.get_container(path, params=params)
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.debug("Failed to load children for %s: %s", rating_key, exc)
            return children

        items = self._extract_items(container)
        if not items:
            return children

        if item_type == "show":
            seasons = [self._serialize_item_overview(child, include_tags=False) for child in items if self._value(child, "type") == "season"]
            if seasons:
                children["seasons"] = seasons
        elif item_type == "season":
            episodes = [self._serialize_item_overview(child, include_tags=False) for child in items if self._value(child, "type") == "episode"]
            if episodes:
                children["episodes"] = episodes
        elif item_type == "artist":
            albums = [self._serialize_item_overview(child, include_tags=False) for child in items if self._value(child, "type") == "album"]
            tracks = [self._serialize_item_overview(child, include_tags=False) for child in items if self._value(child, "type") == "track"]
            if albums:
                children["albums"] = albums
            if tracks:
                children["tracks"] = tracks
        elif item_type == "album":
            tracks = [self._serialize_item_overview(child, include_tags=False) for child in items if self._value(child, "type") == "track"]
            if tracks:
                children["tracks"] = tracks
        elif item_type == "collection":
            children["items"] = [self._serialize_item_overview(child, include_tags=False) for child in items]

        return children

    def _serialize_hubs(
        self,
        hubs_source: Iterable[Any],
        *,
        limit_per_hub: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        hubs: List[Dict[str, Any]] = []
        for hub in self._ensure_list(hubs_source):
            if not isinstance(hub, dict):
                continue
            items = [
                self._serialize_item_overview(child, include_tags=False)
                for child in self._extract_items(hub)
            ]
            if limit_per_hub is not None:
                items = items[: limit_per_hub or 0]
            if not items:
                continue

            size = self._safe_int(self._value(hub, "size"))
            more_value = self._value(hub, "more")
            more = False
            if isinstance(more_value, str):
                more = more_value not in {"0", "false", "False", ""}
            elif isinstance(more_value, (int, float)):
                more = bool(more_value)
            elif isinstance(more_value, bool):
                more = more_value

            hubs.append(
                {
                    "title": self._value(hub, "title"),
                    "type": self._value(hub, "type"),
                    "key": self._value(hub, "key"),
                    "hub_key": self._value(hub, "hubKey"),
                    "hub_identifier": self._value(hub, "hubIdentifier"),
                    "context": self._value(hub, "context"),
                    "size": size,
                    "more": more,
                    "items": items,
                }
            )
        return hubs

    def _related_hubs(self, container: Dict[str, Any]) -> List[Dict[str, Any]]:
        related_payload = container.get("Related")
        if not related_payload:
            return []

        if isinstance(related_payload, dict) and "Hub" in related_payload:
            hubs_source = related_payload.get("Hub")
        else:
            hubs_source = related_payload

        return self._serialize_hubs(hubs_source)

    def _serialize_images(self, item: Any) -> List[Dict[str, Any]]:
        images_source: Any = None
        if isinstance(item, dict):
            images_source = item.get("Image") or item.get("image")
        if images_source is None:
            images_source = self._value(item, "image")
        images: List[Dict[str, Any]] = []
        for entry in self._ensure_list(images_source):
            if isinstance(entry, str):
                images.append({"type": None, "url": entry, "alt": None})
                continue
            if not isinstance(entry, dict):
                continue
            url = self._value(entry, "url")
            if not url:
                continue
            images.append(
                {
                    "type": self._value(entry, "type"),
                    "url": url,
                    "alt": self._value(entry, "alt") or self._value(entry, "title"),
                }
            )
        return images

    def _serialize_ultra_blur(self, item: Any) -> Optional[Dict[str, str]]:
        if not isinstance(item, dict):
            payload = self._value(item, "ultraBlurColors")
        else:
            payload = item.get("UltraBlurColors") or item.get("ultraBlurColors")
            if payload is None:
                payload = self._value(item, "ultraBlurColors")
        if not isinstance(payload, dict):
            return None
        colors = {
            "top_left": payload.get("topLeft") or payload.get("TopLeft"),
            "top_right": payload.get("topRight") or payload.get("TopRight"),
            "bottom_left": payload.get("bottomLeft") or payload.get("BottomLeft"),
            "bottom_right": payload.get("bottomRight") or payload.get("BottomRight"),
        }
        if any(colors.values()):
            return colors
        return None

    def _serialize_ratings(self, item: Any) -> List[Dict[str, Any]]:
        ratings_source: Any = None
        if isinstance(item, dict):
            ratings_source = item.get("Rating") or item.get("rating")
        if ratings_source is None:
            ratings_source = self._value(item, "rating")
        ratings: List[Dict[str, Any]] = []
        for entry in self._ensure_list(ratings_source):
            if not isinstance(entry, dict):
                continue
            ratings.append(
                {
                    "type": self._value(entry, "type"),
                    "image": self._value(entry, "image"),
                    "value": self._value(entry, "value"),
                    "count": self._safe_int(self._value(entry, "count")),
                }
            )
        return ratings

    def _serialize_guids(self, item: Any) -> List[Dict[str, Any]]:
        guid_source: Any = None
        if isinstance(item, dict):
            guid_source = item.get("Guid") or item.get("guid")
        if guid_source is None:
            guid_source = self._value(item, "guid")
        guids: List[Dict[str, Any]] = []
        for entry in self._ensure_list(guid_source):
            if isinstance(entry, str):
                guids.append({"id": entry})
                continue
            if not isinstance(entry, dict):
                continue
            guids.append({"id": self._value(entry, "id"), "type": self._value(entry, "type")})
        return guids

    def _serialize_chapters(self, item: Any) -> List[Dict[str, Any]]:
        chapter_source: Any = None
        if isinstance(item, dict):
            chapter_source = item.get("Chapter") or item.get("chapter")
        if chapter_source is None:
            chapter_source = self._value(item, "chapter")
        chapters: List[Dict[str, Any]] = []
        for entry in self._ensure_list(chapter_source):
            if not isinstance(entry, dict):
                continue
            chapters.append(
                {
                    "id": self._value(entry, "id"),
                    "tag": self._value(entry, "tag"),
                    "index": self._safe_int(self._value(entry, "index")),
                    "start_time": self._safe_int(self._value(entry, "startTimeOffset")),
                    "end_time": self._safe_int(self._value(entry, "endTimeOffset")),
                    "thumb": self._value(entry, "thumb"),
                }
            )
        return chapters

    def _serialize_markers(self, item: Any) -> List[Dict[str, Any]]:
        marker_source: Any = None
        if isinstance(item, dict):
            marker_source = item.get("Marker") or item.get("marker")
        if marker_source is None:
            marker_source = self._value(item, "marker")
        markers: List[Dict[str, Any]] = []
        for entry in self._ensure_list(marker_source):
            if not isinstance(entry, dict):
                continue
            markers.append(
                {
                    "id": self._value(entry, "id"),
                    "type": self._value(entry, "type"),
                    "start_time": self._safe_int(self._value(entry, "startTimeOffset")),
                    "end_time": self._safe_int(self._value(entry, "endTimeOffset")),
                    "final": bool(self._as_bool(self._value(entry, "final"))),
                }
            )
        return markers

    def _serialize_extras(self, item: Any) -> List[Dict[str, Any]]:
        extras_payload: Any = None
        if isinstance(item, dict):
            extras_payload = item.get("Extras") or item.get("extras")
        if extras_payload is None:
            extras_payload = self._value(item, "extras")

        metadata_entries: List[Any] = []
        if isinstance(extras_payload, dict):
            metadata_entries = self._ensure_list(
                extras_payload.get("Metadata")
                or extras_payload.get("metadata")
                or extras_payload.get("Extra")
                or extras_payload.get("extra")
            )
        else:
            metadata_entries = self._ensure_list(extras_payload)

        extras: List[Dict[str, Any]] = []
        for extra in metadata_entries:
            if not isinstance(extra, dict):
                continue
            extras.append(
                {
                    "item": self._serialize_item_overview(extra, include_tags=False),
                    "index": self._safe_int(self._value(extra, "index")),
                    "duration": self._value(extra, "duration"),
                    "subtype": self._value(extra, "subtype"),
                    "extra_type": self._value(extra, "extraType"),
                    "thumb": self._value(extra, "thumb"),
                    "art": self._value(extra, "art"),
                    "media": self._serialize_media(extra),
                }
            )
        return extras

    def _serialize_reviews(self, item: Any) -> List[Dict[str, Any]]:
        review_source: Any = None
        if isinstance(item, dict):
            review_source = item.get("Review") or item.get("review")
        if review_source is None:
            review_source = self._value(item, "review")
        reviews: List[Dict[str, Any]] = []
        for entry in self._ensure_list(review_source):
            if not isinstance(entry, dict):
                continue
            reviews.append(
                {
                    "id": self._value(entry, "id"),
                    "tag": self._value(entry, "tag"),
                    "text": self._value(entry, "text"),
                    "image": self._value(entry, "image"),
                    "link": self._value(entry, "link"),
                    "source": self._value(entry, "source"),
                }
            )
        return reviews

    def _serialize_preferences(self, item: Any) -> List[Dict[str, Any]]:
        preferences_payload: Any = None
        if isinstance(item, dict):
            preferences_payload = item.get("Preferences") or item.get("preferences")
        if preferences_payload is None:
            preferences_payload = self._value(item, "preferences")

        settings_source: Any = None
        if isinstance(preferences_payload, dict):
            settings_source = (
                preferences_payload.get("Setting")
                or preferences_payload.get("setting")
                or preferences_payload.get("Settings")
            )
        else:
            settings_source = preferences_payload

        preferences: List[Dict[str, Any]] = []
        for entry in self._ensure_list(settings_source):
            if not isinstance(entry, dict):
                continue
            preferences.append(
                {
                    "id": self._value(entry, "id"),
                    "label": self._value(entry, "label"),
                    "summary": self._value(entry, "summary"),
                    "type": self._value(entry, "type"),
                    "value": self._value(entry, "value"),
                    "default": self._value(entry, "default"),
                    "hidden": bool(self._as_bool(self._value(entry, "hidden"))),
                    "advanced": bool(self._as_bool(self._value(entry, "advanced"))),
                    "group": self._value(entry, "group"),
                    "enum_values": self._value(entry, "enumValues"),
                }
            )
        return preferences

    def _sort_options(self) -> List[Dict[str, str]]:
        return [
            {"id": sort_id, "label": label, "sort": sort_value}
            for sort_id, label, sort_value in self.DEFAULT_SORTS
        ]

    def _resolve_sort(self, sort_id: Optional[str]) -> str:
        if sort_id:
            for candidate, _label, sort_value in self.DEFAULT_SORTS:
                if candidate == sort_id:
                    return sort_value
        return self.DEFAULT_SORTS[0][2]

    def _normalize_letter(self, letter: Optional[str]) -> Optional[str]:
        if not letter:
            return None
        upper = str(letter).strip().upper()
        if upper in self.LETTER_CHOICES:
            return upper
        if upper in {"#", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"}:
            return "0-9"
        return None

    def _serialize_account(self, payload: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(payload, dict):
            return None
        subscription = payload.get("subscription") or {}
        return {
            "id": payload.get("id"),
            "uuid": payload.get("uuid"),
            "username": payload.get("username"),
            "email": payload.get("email"),
            "title": payload.get("title") or payload.get("username"),
            "thumb": payload.get("thumb"),
            "friendly_name": payload.get("friendlyName"),
            "subscription_active": subscription.get("active"),
            "subscription_plan": subscription.get("plan"),
            "subscription_status": subscription.get("status"),
        }


class PlexImageResponse:
    """Lightweight streaming response wrapper for proxied Plex artwork."""

    def __init__(self, *, status_code: int, headers: Dict[str, str], cache_status: str) -> None:
        self.status_code = int(status_code)
        self.headers = dict(headers)
        self.cache_status = cache_status

    def iter_content(self, chunk_size: int = 8192) -> Iterable[bytes]:
        raise NotImplementedError

    def close(self) -> None:
        return None


class _MemoryImageResponse(PlexImageResponse):
    """Serve artwork bytes held in memory (no caching available)."""

    def __init__(
        self,
        *,
        payload: bytes,
        headers: Dict[str, str],
        status_code: int,
        cache_status: str = "bypass",
    ) -> None:
        super().__init__(status_code=status_code, headers=headers, cache_status=cache_status)
        self._payload = payload

    def iter_content(self, chunk_size: int = 8192) -> Iterable[bytes]:
        if not self._payload:
            return
        yield self._payload

    def close(self) -> None:
        self._payload = b""


class _CachedImageResponse(PlexImageResponse):
    """Serve artwork bytes from the on-disk cache."""

    def __init__(self, *, data_path: Path, headers: Dict[str, str], status_code: int) -> None:
        super().__init__(status_code=status_code, headers=headers, cache_status="hit")
        self._data_path = data_path

    def iter_content(self, chunk_size: int = 8192) -> Iterable[bytes]:
        with self._data_path.open("rb") as handle:
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                yield chunk

    def close(self) -> None:
        return None


class _UpstreamImageResponse(PlexImageResponse):
    """Stream artwork from Plex while optionally persisting it locally."""

    def __init__(
        self,
        *,
        response: requests.Response,
        headers: Dict[str, str],
        cache_paths: Optional[_ImageCachePaths],
        default_cache_control: str,
        post_finalize: Optional[Callable[[
            _ImageCachePaths,
            Dict[str, str],
            int,
        ], None]] = None,
    ) -> None:
        should_cache = cache_paths is not None and response.status_code < 400
        cache_status = "miss" if should_cache else "bypass"
        super().__init__(status_code=response.status_code, headers=headers, cache_status=cache_status)
        self.headers.setdefault("Cache-Control", default_cache_control)
        self._response = response
        self._cache_paths = cache_paths if should_cache else None
        self._default_cache_control = default_cache_control
        self._post_finalize = post_finalize if should_cache else None
        self._temp_path: Optional[Path] = None
        self._cache_file: Optional[IO[bytes]] = None
        self._bytes_written = 0
        self._stream_completed = False
        self._closed = False
        if self._cache_paths is not None:
            self._prepare_cache_file()

    def _prepare_cache_file(self) -> None:
        if not self._cache_paths:
            return
        try:
            self._cache_paths.data_path.parent.mkdir(parents=True, exist_ok=True)
            self._temp_path = self._cache_paths.data_path.with_suffix(".tmp")
            self._cache_file = self._temp_path.open("wb")
        except OSError as exc:  # pragma: no cover - depends on filesystem state
            logger.warning(
                "Unable to prepare Plex image cache file (%s): %s",
                self._cache_paths.data_path,
                exc,
            )
            self._discard_cache_file()

    def _discard_cache_file(self) -> None:
        if self._cache_file is not None:
            try:
                self._cache_file.close()
            except OSError:
                pass
            self._cache_file = None
        if self._temp_path is not None:
            try:
                self._temp_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
            self._temp_path = None
        self._cache_paths = None
        self._post_finalize = None
        if self.cache_status == "miss":
            self.cache_status = "bypass"

    def iter_content(self, chunk_size: int = 8192) -> Iterable[bytes]:
        try:
            for chunk in self._response.iter_content(chunk_size=chunk_size):
                if not chunk:
                    continue
                if self._cache_file is not None:
                    try:
                        self._cache_file.write(chunk)
                        self._bytes_written += len(chunk)
                    except OSError:  # pragma: no cover - depends on disk state
                        logger.warning(
                            "Failed to write Plex image cache chunk for %s",
                            self._cache_paths.data_path if self._cache_paths else "unknown",
                        )
                        self._discard_cache_file()
                yield chunk
            self._stream_completed = True
        finally:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        try:
            self._response.close()
        finally:
            if self._cache_file is not None:
                try:
                    self._cache_file.close()
                except OSError:
                    pass
                self._cache_file = None

            if self._cache_paths is not None and self._temp_path is not None:
                if self._stream_completed and self.status_code < 400:
                    self._finalize_cache()
                else:
                    self._discard_cache_file()
            elif self._temp_path is not None:
                self._discard_cache_file()

    def _finalize_cache(self) -> None:
        if not self._cache_paths or not self._temp_path:
            return

        try:
            os.replace(self._temp_path, self._cache_paths.data_path)
        except OSError as exc:  # pragma: no cover - depends on filesystem state
            logger.warning(
                "Failed to finalize Plex image cache file (%s): %s",
                self._cache_paths.data_path,
                exc,
            )
            self._discard_cache_file()
            return

        self._temp_path = None

        metadata_headers = dict(self.headers)
        metadata_headers.setdefault("Cache-Control", self._default_cache_control)
        metadata_headers["Content-Length"] = str(self._bytes_written)

        metadata_payload = {
            "headers": metadata_headers,
            "status_code": self.status_code,
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "canonical": self._cache_paths.canonical,
            "variant": self._cache_paths.variant,
        }

        try:
            self._cache_paths.metadata_path.parent.mkdir(parents=True, exist_ok=True)
            with self._cache_paths.metadata_path.open("w", encoding="utf-8") as handle:
                json.dump(metadata_payload, handle)
        except Exception as exc:  # pragma: no cover - best effort logging
            logger.warning(
                "Failed to write Plex image cache metadata (%s): %s",
                self._cache_paths.metadata_path,
                exc,
            )

        if self._post_finalize is not None:
            try:
                self._post_finalize(
                    self._cache_paths,
                    dict(metadata_headers),
                    self.status_code,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "Post-cache hook failed for %s: %s",
                    self._cache_paths.data_path,
                    exc,
                )


__all__ = ["PlexService", "PlexServiceError", "PlexNotConnectedError"]
