"""Helpers to integrate with Plex using direct token-based connections."""
from __future__ import annotations

import logging
import secrets
import string
import warnings
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import ipaddress
import requests
from plexapi.exceptions import BadRequest
from plexapi.myplex import BASE_HEADERS
from plexapi.server import PlexServer
from urllib3.exceptions import InsecureRequestWarning

from .settings_service import SettingsService

logger = logging.getLogger(__name__)


class PlexServiceError(RuntimeError):
    """Raised when the Plex integration cannot complete an operation."""


class PlexNotConnectedError(PlexServiceError):
    """Raised when a Plex operation requires stored credentials."""


class PlexService:
    """Manage Plex connectivity and library operations."""
    LETTER_CHOICES: Tuple[str, ...] = tuple(string.ascii_uppercase) + ("0-9",)
    PLAYABLE_TYPES: Tuple[str, ...] = ("movie", "episode", "clip", "video", "track")
    DEFAULT_SORTS: Tuple[Tuple[str, str, str], ...] = (
        ("title_asc", "Title (A-Z)", "titleSort:asc"),
        ("title_desc", "Title (Z-A)", "titleSort:desc"),
        ("added_desc", "Recently Added", "addedAt:desc"),
        ("added_asc", "Added (Oldest)", "addedAt:asc"),
        ("released_desc", "Release Date (Newest)", "originallyAvailableAt:desc"),
        ("released_asc", "Release Date (Oldest)", "originallyAvailableAt:asc"),
        ("last_viewed_desc", "Last Viewed", "lastViewedAt:desc"),
    )

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
    ) -> None:
        self._settings = settings_service
        self._client_identifier = client_identifier or secrets.token_hex(12)
        self._product = product or "Publex"
        self._device_name = device_name or "Publex Admin"
        self._platform = platform or "Publex"
        self._version = version or "1.0"
        self._server_base_url = (server_base_url or "").strip() or None
        self._allow_account_lookup = bool(allow_account_lookup)

    # ------------------------------------------------------------------
    # Public API

    def connect(
        self,
        *,
        server_url: str,
        token: str,
        verify_ssl: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Connect to a Plex server using a direct token."""

        normalized_url = self._normalize_server_url(server_url)
        token_value = str(token or "").strip()
        if not token_value:
            raise PlexServiceError("A Plex authentication token is required.")

        verify = True if verify_ssl is None else bool(verify_ssl)

        try:
            server, actual_verify = self._connect_server_with_settings(
                base_url=normalized_url,
                token=token_value,
                verify_ssl=verify,
            )
        except Exception as exc:
            logger.exception("Failed to connect to Plex server at %s: %s", normalized_url, exc)
            raise PlexServiceError("Unable to connect to the Plex server with the provided details.") from exc

        account_info = None
        if self._allow_account_lookup:
            account_info = self._load_account_snapshot(server)
        snapshot = self._server_snapshot(server, base_url=normalized_url, verify_ssl=actual_verify)
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
        """Return the available Plex library sections and server metadata."""

        server, snapshot = self._connect_server()
        try:
            sections = server.library.sections()
        except Exception as exc:  # pragma: no cover - depends on Plex
            logger.exception("Failed to list Plex sections: %s", exc)
            raise PlexServiceError("Unable to load Plex library sections.") from exc

        return {
            "server": snapshot,
            "sections": [self._serialize_section(section) for section in sections],
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
        limit = max(1, min(int(limit), 200))

        server, snapshot = self._connect_server()

        section = None
        last_error: Optional[Exception] = None
        candidates: List[Any] = []
        try:
            section = server.library.sectionByID(int(section_id))
        except Exception as exc:
            last_error = exc
        if section is None:
            try:
                section = server.library.section(str(section_id))
            except Exception as exc:  # pragma: no cover - depends on Plex
                last_error = exc
        if section is None:
            logger.exception("Failed to resolve Plex section %s: %s", section_id, last_error)
            raise PlexServiceError("Plex library section not found.") from last_error

        plex_filters: Dict[str, Any] = {}
        normalized_letter = self._normalize_letter(letter)
        if normalized_letter:
            plex_filters["firstCharacter"] = "#" if normalized_letter == "0-9" else normalized_letter

        if watch_state == "unwatched":
            plex_filters["unwatched"] = True
        elif watch_state == "in_progress":
            plex_filters["inProgress"] = True
        elif watch_state == "watched":
            plex_filters["viewCount>>"] = 0

        if genre:
            plex_filters["genre"] = genre
        if collection:
            plex_filters["collection"] = collection
        if year:
            try:
                plex_filters["year"] = int(year)
            except (TypeError, ValueError):
                plex_filters["year"] = year

        sort_param = self._resolve_sort(sort)
        title_query = search.strip() if isinstance(search, str) else None

        try:
            results = section.search(
                title=title_query or None,
                sort=sort_param,
                filters=plex_filters or None,
                container_start=offset,
                container_size=limit,
            )
        except BadRequest as exc:  # pragma: no cover - depends on Plex behaviour
            logger.warning("Plex rejected library query for section %s: %s", section_id, exc)
            raise PlexServiceError("Invalid Plex library filter combination.") from exc
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to load Plex items for section %s: %s", section_id, exc)
            raise PlexServiceError("Unable to load Plex library items.") from exc

        items = list(results)
        total_results = getattr(results, "totalSize", None)
        if total_results is None:
            total_results = offset + len(items)

        payload = {
            "server": snapshot,
            "section": self._serialize_section(section),
            "items": [self._serialize_item_overview(item, include_tags=False) for item in items],
            "pagination": {
                "offset": offset,
                "limit": limit,
                "total": total_results,
                "size": len(items),
            },
            "sort_options": self._sort_options(),
            "letter": normalized_letter,
            "filters": self._section_filter_options(section),
            "applied": {
                "sort": sort,
                "search": title_query,
                "watch_state": watch_state,
                "genre": genre,
                "collection": collection,
                "year": year,
            },
        }
        return payload

    def item_details(self, rating_key: Any) -> Dict[str, Any]:
        """Return detailed metadata (including children) for a Plex item."""

        server, snapshot = self._connect_server()

        item = None
        last_error: Optional[Exception] = None
        for candidate in (rating_key, str(rating_key)):
            try:
                if candidate is None:
                    continue
                if isinstance(candidate, int) or (isinstance(candidate, str) and candidate.isdigit()):
                    item = server.fetchItem(int(candidate))
                else:
                    item = server.fetchItem(str(candidate))
                break
            except Exception as exc:  # pragma: no cover - depends on Plex data
                last_error = exc
        if item is None:
            logger.exception("Failed to load Plex item %s: %s", rating_key, last_error)
            raise PlexServiceError("Plex library item not found.") from last_error

        overview = self._serialize_item_overview(item, include_tags=True)
        response = {
            "server": snapshot,
            "item": overview,
            "media": self._serialize_media(item),
            "children": self._child_overviews(item),
        }
        return response

    def resolve_media_source(self, rating_key: Any, *, part_id: Optional[Any] = None) -> Dict[str, Any]:
        """Resolve a Plex item's media path for transcoding."""

        server, _snapshot = self._connect_server()

        try:
            item = server.fetchItem(int(rating_key)) if str(rating_key).isdigit() else server.fetchItem(str(rating_key))
        except Exception as exc:  # pragma: no cover - depends on Plex
            logger.exception("Failed to resolve Plex media for %s: %s", rating_key, exc)
            raise PlexServiceError("Unable to resolve Plex media source.") from exc

        media_items = getattr(item, "media", None) or []
        selected_media = None
        selected_part = None
        target_part = str(part_id) if part_id is not None else None

        for medium in media_items:
            parts = getattr(medium, "parts", []) or []
            if target_part:
                for part in parts:
                    if str(getattr(part, "id", None)) == target_part:
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

        file_path = getattr(selected_part, "file", None)
        if not file_path:
            raise PlexServiceError("Media part is missing an accessible file path.")

        item_type = getattr(item, "type", None)
        media_kind = "audio" if item_type == "track" else "video"

        payload = {
            "item": self._serialize_item_overview(item, include_tags=False),
            "file": file_path,
            "media_type": media_kind,
            "part_id": getattr(selected_part, "id", None),
            "container": getattr(selected_part, "container", None),
            "duration": getattr(selected_part, "duration", None),
            "video_codec": getattr(selected_media, "videoCodec", None) if selected_media else None,
            "audio_codec": getattr(selected_media, "audioCodec", None) if selected_media else None,
        }
        return payload

    def fetch_image(self, path: str, params: Optional[Dict[str, Any]] = None) -> requests.Response:
        """Fetch an image or art asset from Plex for proxying."""

        if not path or not isinstance(path, str):
            raise PlexServiceError("Invalid Plex image path.")
        normalized = path if path.startswith('/') else f'/{path}'

        server, _snapshot = self._connect_server()
        url = server.url(normalized, includeToken=True)
        session = server._session  # pylint: disable=protected-access
        try:
            response = session.get(url, params=params or {}, stream=True, timeout=30)
        except requests.RequestException as exc:  # pragma: no cover - network errors
            logger.exception("Failed to proxy Plex image %s: %s", path, exc)
            raise PlexServiceError("Unable to fetch Plex image.") from exc
        if response.status_code >= 400:
            response.close()
            raise PlexServiceError(f"Plex returned HTTP {response.status_code} for image request.")
        return response

    # ------------------------------------------------------------------
    # Internal helpers

    def _build_headers(self) -> Dict[str, Any]:
        headers = dict(BASE_HEADERS)
        headers["X-Plex-Client-Identifier"] = self._client_identifier
        headers["X-Plex-Product"] = self._product
        headers["X-Plex-Device"] = self._device_name
        headers["X-Plex-Device-Name"] = self._device_name
        headers["X-Plex-Platform"] = self._platform
        headers["X-Plex-Version"] = self._version
        headers.setdefault("X-Plex-Platform-Version", "1.0")
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

    def _create_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(self._build_headers())
        return session

    # ------------------------------------------------------------------
    # Connection helpers

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

    def _connect_server_with_settings(
        self,
        *,
        base_url: str,
        token: str,
        verify_ssl: bool,
    ) -> Tuple[PlexServer, bool]:
        session = self._create_session()
        session.verify = verify_ssl

        def instantiate(sess: requests.Session) -> PlexServer:
            return PlexServer(base_url, token=token, session=sess, timeout=10)

        if verify_ssl:
            server = instantiate(session)
            return server, verify_ssl

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", InsecureRequestWarning)
            server = instantiate(session)
        return server, verify_ssl

    def _load_account_snapshot(self, server: PlexServer) -> Optional[Dict[str, Any]]:
        try:
            account = server.account()
        except Exception as exc:  # pragma: no cover - depends on Plex cloud APIs
            logger.debug("Unable to fetch Plex account details from server: %s", exc)
            return None
        if not account:
            return None
        return self._serialize_account(account)

    def _connect_server(self) -> Tuple[PlexServer, Dict[str, Any]]:
        base_url = self._get_server_base_url()
        token = self._get_token()
        verify_ssl = self._get_verify_ssl()

        try:
            server, actual_verify = self._connect_server_with_settings(
                base_url=base_url,
                token=token,
                verify_ssl=verify_ssl,
            )
        except Exception as exc:  # pragma: no cover - depends on Plex availability
            logger.exception("Failed to connect to Plex server using stored configuration: %s", exc)
            raise PlexServiceError("Unable to connect to the stored Plex server.") from exc

        snapshot = self._server_snapshot(server, base_url=base_url, verify_ssl=actual_verify)
        updates: Dict[str, Any] = {
            "server": snapshot,
            "last_connected_at": datetime.now(timezone.utc).isoformat(),
        }
        if actual_verify != verify_ssl:
            updates["verify_ssl"] = actual_verify

        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        if self._allow_account_lookup and not settings.get("account"):
            account_info = self._load_account_snapshot(server)
            if account_info is not None:
                updates["account"] = account_info

        self._update_settings(updates)
        return server, snapshot

    @staticmethod
    def _isoformat(value: Any) -> Optional[str]:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.isoformat()
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        return None

    @staticmethod
    def _tag_list(tags: Iterable[Any]) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        if not tags:
            return items
        for tag in tags:
            label = getattr(tag, "tag", None)
            if not label:
                continue
            items.append({
                "id": getattr(tag, "id", None),
                "tag": label,
                "title": getattr(tag, "title", None) or label,
            })
        return items

    def _server_snapshot(
        self,
        server: PlexServer,
        *,
        base_url: Optional[str] = None,
        verify_ssl: Optional[bool] = None,
    ) -> Dict[str, Any]:
        normalized = (base_url or getattr(server, "_baseurl", None) or "").strip()
        if normalized:
            normalized = normalized.rstrip("/")

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
            "name": getattr(server, "friendlyName", None),
            "product": getattr(server, "product", None),
            "platform": getattr(server, "platform", None),
            "version": getattr(server, "version", None),
            "machine_identifier": getattr(server, "machineIdentifier", None),
            "connections": connections,
        }
        if normalized:
            snapshot["base_url"] = normalized
        if verify_ssl is not None:
            snapshot["verify_ssl"] = bool(verify_ssl)
        return snapshot

    def _serialize_section(self, section: Any) -> Dict[str, Any]:
        key = getattr(section, "key", None)
        section_id: Optional[int] = None
        if key is not None:
            try:
                section_id = int(str(key).strip("/").split("/")[-1])
            except (ValueError, TypeError):  # pragma: no cover - defensive parsing
                section_id = None

        size = getattr(section, "size", None)
        if size is None:
            size = getattr(section, "totalSize", None) or getattr(section, "count", None)

        return {
            "id": section_id,
            "key": key,
            "uuid": getattr(section, "uuid", None),
            "title": getattr(section, "title", None),
            "type": getattr(section, "type", None),
            "language": getattr(section, "language", None),
            "agent": getattr(section, "agent", None),
            "scanner": getattr(section, "scanner", None),
            "created_at": self._isoformat(getattr(section, "createdAt", None)),
            "updated_at": self._isoformat(getattr(section, "updatedAt", None)),
            "thumb": getattr(section, "thumb", None),
            "art": getattr(section, "art", None),
            "size": size,
        }

    def _serialize_item_overview(self, item: Any, *, include_tags: bool = True) -> Dict[str, Any]:
        rating_key = getattr(item, "ratingKey", None)
        item_type = getattr(item, "type", None)
        data = {
            "rating_key": str(rating_key) if rating_key is not None else None,
            "key": getattr(item, "key", None),
            "type": item_type,
            "title": getattr(item, "title", None),
            "sort_title": getattr(item, "titleSort", None),
            "summary": getattr(item, "summary", None),
            "tagline": getattr(item, "tagline", None),
            "year": getattr(item, "year", None),
            "index": getattr(item, "index", None),
            "parent_index": getattr(item, "parentIndex", None),
            "grandparent_title": getattr(item, "grandparentTitle", None),
            "parent_title": getattr(item, "parentTitle", None),
            "grandparent_rating_key": getattr(item, "grandparentRatingKey", None),
            "parent_rating_key": getattr(item, "parentRatingKey", None),
            "leaf_count": getattr(item, "leafCount", None),
            "child_count": getattr(item, "childCount", None),
            "duration": getattr(item, "duration", None),
            "added_at": self._isoformat(getattr(item, "addedAt", None)),
            "updated_at": self._isoformat(getattr(item, "updatedAt", None)),
            "last_viewed_at": self._isoformat(getattr(item, "lastViewedAt", None)),
            "view_count": getattr(item, "viewCount", None),
            "thumb": getattr(item, "thumb", None) or getattr(item, "grandparentThumb", None),
            "grandparent_thumb": getattr(item, "grandparentThumb", None),
            "art": getattr(item, "art", None) or getattr(item, "grandparentArt", None),
            "guid": getattr(item, "guid", None),
            "content_rating": getattr(item, "contentRating", None),
            "studio": getattr(item, "studio", None),
            "rating": getattr(item, "rating", None),
            "audience_rating": getattr(item, "audienceRating", None),
            "user_rating": getattr(item, "userRating", None),
            "original_title": getattr(item, "originalTitle", None),
            "library_section_id": getattr(item, "librarySectionID", None),
            "playable": bool(item_type) and item_type in self.PLAYABLE_TYPES,
        }

        if include_tags:
            data.update(
                {
                    "genres": self._tag_list(getattr(item, "genres", None)),
                    "collections": self._tag_list(getattr(item, "collections", None)),
                    "writers": self._tag_list(getattr(item, "writers", None)),
                    "directors": self._tag_list(getattr(item, "directors", None)),
                    "actors": self._tag_list(getattr(item, "actors", None)),
                    "producers": self._tag_list(getattr(item, "producers", None)),
                    "labels": self._tag_list(getattr(item, "labels", None)),
                    "moods": self._tag_list(getattr(item, "moods", None)),
                    "styles": self._tag_list(getattr(item, "styles", None)),
                    "countries": self._tag_list(getattr(item, "countries", None)),
                }
            )

        # Music-specific fields
        if item_type in {"track", "album", "artist"}:
            data.update(
                {
                    "album": getattr(item, "parentTitle", None),
                    "artist": getattr(item, "grandparentTitle", None) or getattr(item, "parentTitle", None),
                    "album_rating_key": getattr(item, "parentRatingKey", None),
                    "artist_rating_key": getattr(item, "grandparentRatingKey", None),
                }
            )

        if item_type in {"episode", "season", "show"}:
            data.update(
                {
                    "show_title": getattr(item, "grandparentTitle", None) or getattr(item, "parentTitle", None),
                    "season_title": getattr(item, "parentTitle", None),
                    "season_number": getattr(item, "parentIndex", None),
                    "episode_number": getattr(item, "index", None),
                }
            )

        return data

    def _serialize_streams(self, streams: Iterable[Any]) -> List[Dict[str, Any]]:
        payload: List[Dict[str, Any]] = []
        if not streams:
            return payload
        for stream in streams:
            payload.append({
                "id": getattr(stream, "id", None),
                "index": getattr(stream, "index", None),
                "stream_type": getattr(stream, "streamType", None),
                "type": getattr(stream, "type", None),
                "codec": getattr(stream, "codec", None) or getattr(stream, "codecName", None),
                "codec_id": getattr(stream, "codecID", None),
                "language": getattr(stream, "language", None) or getattr(stream, "languageCode", None),
                "channels": getattr(stream, "channels", None),
                "profile": getattr(stream, "profile", None),
                "bitrate": getattr(stream, "bitrate", None),
                "sampling_rate": getattr(stream, "samplingRate", None),
                "width": getattr(stream, "width", None),
                "height": getattr(stream, "height", None),
                "frame_rate": getattr(stream, "frameRate", None),
                "color_space": getattr(stream, "colorSpace", None),
                "default": getattr(stream, "default", None),
                "forced": getattr(stream, "forced", None),
                "title": getattr(stream, "title", None),
                "display_title": getattr(stream, "displayTitle", None),
            })
        return payload

    def _serialize_media_part(self, part: Any) -> Dict[str, Any]:
        return {
            "id": getattr(part, "id", None),
            "key": getattr(part, "key", None),
            "file": getattr(part, "file", None),
            "duration": getattr(part, "duration", None),
            "size": getattr(part, "size", None),
            "container": getattr(part, "container", None),
            "optimized_for_streaming": getattr(part, "optimizedForStreaming", None),
            "has64bit_offsets": getattr(part, "has64bitOffsets", None),
            "indexes": getattr(part, "indexes", None),
            "streams": self._serialize_streams(getattr(part, "streams", None)),
        }

    def _serialize_media(self, item: Any) -> List[Dict[str, Any]]:
        payload: List[Dict[str, Any]] = []
        media_items = getattr(item, "media", None)
        if not media_items:
            return payload
        for medium in media_items:
            parts = [self._serialize_media_part(part) for part in getattr(medium, "parts", []) or []]
            payload.append({
                "id": getattr(medium, "id", None),
                "duration": getattr(medium, "duration", None),
                "bitrate": getattr(medium, "bitrate", None),
                "width": getattr(medium, "width", None),
                "height": getattr(medium, "height", None),
                "aspect_ratio": getattr(medium, "aspectRatio", None),
                "audio_channels": getattr(medium, "audioChannels", None),
                "audio_codec": getattr(medium, "audioCodec", None),
                "video_codec": getattr(medium, "videoCodec", None),
                "video_resolution": getattr(medium, "videoResolution", None),
                "container": getattr(medium, "container", None),
                "parts": parts,
            })
        return payload

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

    def _section_filter_options(self, section: Any) -> Dict[str, List[Dict[str, Any]]]:
        fields = [
            ("genre", "Genres"),
            ("collection", "Collections"),
            ("year", "Years"),
            ("contentRating", "Content Ratings"),
        ]
        options: Dict[str, List[Dict[str, Any]]] = {}
        for field_name, label in fields:
            try:
                choices = section.listFilterChoices(field_name)
            except Exception:  # pragma: no cover - depends on Plex metadata
                continue
            if not choices:
                continue
            option_items: List[Dict[str, Any]] = []
            for choice in choices:
                key = getattr(choice, "key", None)
                title = getattr(choice, "title", None) or getattr(choice, "value", None)
                if key is None and title is None:
                    continue
                option_items.append({
                    "id": key if key is None else str(key),
                    "title": title or str(key),
                    "count": getattr(choice, "count", None),
                })
            if option_items:
                options[field_name] = option_items
        return options

    def _title_matches_letter(self, item: Any, letter: str) -> bool:
        title = getattr(item, "titleSort", None) or getattr(item, "title", None)
        if not title:
            return letter == "0-9"
        first = str(title).lstrip().upper()[:1]
        if not first:
            return letter == "0-9"
        if letter == "0-9":
            return first.isdigit()
        return first == letter

    def _child_overviews(self, item: Any) -> Dict[str, List[Dict[str, Any]]]:
        item_type = getattr(item, "type", None)
        children: Dict[str, List[Dict[str, Any]]] = {}

        def serialize_list(method_name: str, key: str) -> None:
            try:
                method = getattr(item, method_name)
            except AttributeError:
                return
            try:
                results = method()
            except Exception as exc:  # pragma: no cover - depends on Plex items
                logger.warning("Failed to load %s for %s: %s", key, getattr(item, "ratingKey", None), exc)
                return
            if results:
                children[key] = [self._serialize_item_overview(child, include_tags=False) for child in results]

        if item_type == "show":
            serialize_list("seasons", "seasons")
        elif item_type == "season":
            serialize_list("episodes", "episodes")
        elif item_type == "artist":
            serialize_list("albums", "albums")
            serialize_list("tracks", "tracks")
        elif item_type == "album":
            serialize_list("tracks", "tracks")
        elif item_type == "collection":
            serialize_list("items", "items")

        return children

    @staticmethod
    def _serialize_account(account: Any) -> Dict[str, Any]:
        return {
            "id": getattr(account, "id", None),
            "uuid": getattr(account, "uuid", None),
            "username": getattr(account, "username", None),
            "email": getattr(account, "email", None),
            "title": getattr(account, "title", None),
            "thumb": getattr(account, "thumb", None),
            "friendly_name": getattr(account, "friendlyName", None),
            "subscription_active": getattr(account, "subscriptionActive", None),
            "subscription_plan": getattr(account, "subscriptionPlan", None),
            "subscription_status": getattr(account, "subscriptionStatus", None),
        }


__all__ = ["PlexService", "PlexServiceError", "PlexNotConnectedError"]
