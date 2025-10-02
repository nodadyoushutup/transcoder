"""Helpers to integrate with Plex using direct HTTP calls."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse

import requests
from urllib3.exceptions import InsecureRequestWarning

from .settings_service import SettingsService

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

    def list_sections(self) -> Dict[str, Any]:
        """Return available Plex library sections and server metadata."""

        client, snapshot = self._connect_client()
        server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"
        logger.info(
            "Listing Plex sections (server=%s, base_url=%s)",
            server_name,
            snapshot.get("base_url"),
        )

        try:
            container = client.get_container("/library/sections")
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to list Plex sections: %s", exc)
            raise PlexServiceError("Unable to load Plex library sections.") from exc

        sections = [self._serialize_section(entry) for entry in self._ensure_list(container.get("Directory"))]

        logger.info("Loaded %d Plex sections from server=%s", len(sections), server_name)
        return {
            "server": snapshot,
            "sections": sections,
            "sort_options": self._sort_options(),
            "letters": list(self.LETTER_CHOICES),
        }

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
    ) -> Dict[str, Any]:
        """Browse a Plex library section applying the provided filters."""

        offset = max(0, int(offset))
        limit = max(1, min(int(limit), self.MAX_SECTION_PAGE_SIZE))

        client, snapshot = self._connect_client()
        server_name = snapshot.get("name") or snapshot.get("machine_identifier") or "unknown"

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

        try:
            container = client.get_container(path, params=params)
        except PlexServiceError:
            raise
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to load Plex items for section %s: %s", section_id, exc)
            raise PlexServiceError("Unable to load Plex library items.") from exc

        items = [self._serialize_item_overview(item, include_tags=False) for item in self._extract_items(container)]

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
        logger.info(
            "Loaded %d Plex items (section=%s, server=%s, total=%s)",
            len(items),
            section_id,
            server_name,
            total_results,
        )
        return payload

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

    def item_details(self, rating_key: Any) -> Dict[str, Any]:
        """Return detailed metadata (including children) for a Plex item."""

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
        }
        return response

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

        cache_paths = self._prepare_image_cache_paths(normalized, params)
        cached = self._load_cached_image(cache_paths)
        if cached is not None:
            logger.info(
                "Serving cached Plex image (path=%s, params=%s)",
                normalized,
                params or {},
            )
            return cached

        client, _snapshot = self._connect_client()

        include_token = "X-Plex-Token=" not in normalized
        try:
            response = client.get(
                normalized,
                params=params,
                parse=False,
                stream=True,
                include_token=include_token,
            )
        except Exception as exc:  # pragma: no cover - depends on network
            logger.exception("Failed to proxy Plex image %s: %s", normalized, exc)
            raise PlexServiceError("Unable to fetch Plex image.") from exc

        headers = self._filter_image_headers(response.headers)
        headers.setdefault("Cache-Control", self.DEFAULT_CACHE_CONTROL)

        proxy_response = _UpstreamImageResponse(
            response=response,
            headers=headers,
            cache_paths=cache_paths,
            default_cache_control=self.DEFAULT_CACHE_CONTROL,
        )

        logger.info(
            "Proxying Plex image request (path=%s, params=%s, cache=%s, status=%s)",
            normalized,
            params or {},
            proxy_response.cache_status,
            proxy_response.status_code,
        )
        return proxy_response

    def _prepare_image_cache_paths(
        self,
        normalized: str,
        params: Optional[Dict[str, Any]],
    ) -> Optional[_ImageCachePaths]:
        if not self._image_cache_dir:
            return None

        canonical = self._build_image_cache_canonical(normalized, params)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        data_path = self._image_cache_dir / f"{digest}.bin"
        metadata_path = self._image_cache_dir / f"{digest}.json"
        return _ImageCachePaths(canonical=canonical, data_path=data_path, metadata_path=metadata_path)

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

        metadata: Dict[str, Any]
        try:
            with cache_paths.metadata_path.open("r", encoding="utf-8") as handle:
                metadata = json.load(handle)
        except FileNotFoundError:
            metadata = {}
        except Exception as exc:  # pragma: no cover - best effort logging only
            logger.warning(
                "Failed to read cached Plex image metadata (%s): %s",
                cache_paths.metadata_path,
                exc,
            )
            metadata = {}

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

    def _connect_client(self) -> Tuple[PlexClient, Dict[str, Any]]:
        base_url = self._get_server_base_url()
        token = self._get_token()
        verify_ssl = self._get_verify_ssl()

        try:
            client, actual_verify = self._build_client(base_url, token, verify_ssl)
            identity = client.get_container("/identity")
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to connect to Plex server using stored configuration: %s", exc)
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
            "playable": bool(item_type) and item_type in self.PLAYABLE_TYPES,
        }

        if include_tags:
            data.update(
                {
                    "genres": self._tag_list(self._value(item, "genres")),
                    "collections": self._tag_list(self._value(item, "collections")),
                    "writers": self._tag_list(self._value(item, "writers")),
                    "directors": self._tag_list(self._value(item, "directors")),
                    "actors": self._tag_list(self._value(item, "actors")),
                    "producers": self._tag_list(self._value(item, "producers")),
                    "labels": self._tag_list(self._value(item, "labels")),
                    "moods": self._tag_list(self._value(item, "moods")),
                    "styles": self._tag_list(self._value(item, "styles")),
                    "countries": self._tag_list(self._value(item, "countries")),
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
            })
        return items

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

    def _related_hubs(self, container: Dict[str, Any]) -> List[Dict[str, Any]]:
        related_payload = container.get("Related")
        if not related_payload:
            return []

        if isinstance(related_payload, dict) and "Hub" in related_payload:
            hubs_source = self._ensure_list(related_payload.get("Hub"))
        else:
            hubs_source = self._ensure_list(related_payload)

        hubs: List[Dict[str, Any]] = []
        for hub in hubs_source:
            if not isinstance(hub, dict):
                continue
            items = [
                self._serialize_item_overview(child, include_tags=False)
                for child in self._extract_items(hub)
            ]
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
    ) -> None:
        should_cache = cache_paths is not None and response.status_code < 400
        cache_status = "miss" if should_cache else "bypass"
        super().__init__(status_code=response.status_code, headers=headers, cache_status=cache_status)
        self.headers.setdefault("Cache-Control", default_cache_control)
        self._response = response
        self._cache_paths = cache_paths if should_cache else None
        self._default_cache_control = default_cache_control
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


__all__ = ["PlexService", "PlexServiceError", "PlexNotConnectedError"]
