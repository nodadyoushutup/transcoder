"""Helpers to integrate with Plex via OAuth and persist account metadata."""
from __future__ import annotations

import logging
import secrets
import string
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from plexapi.exceptions import BadRequest, NotFound
from plexapi.myplex import BASE_HEADERS, MyPlexAccount, MyPlexPinLogin, MyPlexResource
from plexapi.server import PlexServer

from .settings_service import SettingsService

logger = logging.getLogger(__name__)


class PlexServiceError(RuntimeError):
    """Raised when the Plex integration cannot complete an operation."""


class PlexNotConnectedError(PlexServiceError):
    """Raised when a Plex operation requires stored credentials."""


@dataclass
class _ActivePin:
    """Tracks transient state for an in-flight OAuth PIN."""

    pin: MyPlexPinLogin
    created_at: datetime
    expires_at: datetime
    forward_url: Optional[str]

    def is_expired(self, now: datetime) -> bool:
        return now >= self.expires_at or bool(getattr(self.pin, "expired", False))


class PlexService:
    """Manage Plex OAuth flows and persist account credentials."""

    PIN_TTL = timedelta(minutes=10)
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
    ) -> None:
        self._settings = settings_service
        self._client_identifier = client_identifier or secrets.token_hex(12)
        self._product = product or "Publex"
        self._device_name = device_name or "Publex Admin"
        self._platform = platform or "Publex"
        self._version = version or "1.0"
        self._active_pins: Dict[str, _ActivePin] = {}

    # ------------------------------------------------------------------
    # Public API

    def start_oauth(self, *, forward_url: Optional[str] = None) -> Dict[str, Any]:
        """Initiate a Plex OAuth flow using the PIN login mechanism."""

        headers = self._build_headers()
        logger.info("Starting Plex OAuth flow with client identifier %s", headers["X-Plex-Client-Identifier"])
        try:
            pin = MyPlexPinLogin(headers=headers, oauth=True)
        except Exception as exc:  # pragma: no cover - network failures
            logger.exception("Unable to acquire Plex login PIN: %s", exc)
            raise PlexServiceError("Unable to start Plex OAuth flow.") from exc

        pin_id = getattr(pin, "_id", None)
        code = getattr(pin, "_code", None)
        if not pin_id or not code:
            raise PlexServiceError("Plex did not provide a valid PIN response.")

        now = datetime.now(timezone.utc)
        expires_at = now + self.PIN_TTL
        oauth_url = pin.oauthUrl(forward_url)
        self._active_pins[pin_id] = _ActivePin(pin=pin, created_at=now, expires_at=expires_at, forward_url=forward_url)

        self._update_settings({
            "status": "pending",
            "pin_id": pin_id,
            "pin_code": code,
            "pin_expires_at": expires_at.isoformat(),
        })

        return {
            "pin_id": pin_id,
            "code": code,
            "oauth_url": oauth_url,
            "expires_at": expires_at.isoformat(),
            "status": "pending",
        }

    def poll_oauth(self, pin_id: str) -> Dict[str, Any]:
        """Check whether the provided PIN has been authorized."""

        now = datetime.now(timezone.utc)
        entry = self._active_pins.get(pin_id)
        if not entry:
            # PIN may have been loaded before a process restart; treat as expired.
            settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
            stored_pin_id = settings.get("pin_id")
            if stored_pin_id == pin_id:
                self._clear_pin_state(status=settings.get("status") or "disconnected")
            raise PlexServiceError("Unknown or expired PIN identifier.")

        pin = entry.pin
        if entry.is_expired(now):
            logger.info("Plex OAuth PIN %s expired", pin_id)
            pin.stop()
            self._active_pins.pop(pin_id, None)
            self._clear_pin_state(status="expired")
            return {"status": "expired"}

        try:
            authorized = pin.checkLogin()
        except BadRequest as exc:  # pragma: no cover - depends on Plex API behaviour
            logger.warning("Plex returned error while checking PIN %s: %s", pin_id, exc)
            self._active_pins.pop(pin_id, None)
            self._clear_pin_state(status="error")
            raise PlexServiceError("Plex rejected the login attempt.") from exc
        except Exception as exc:  # pragma: no cover - network / unexpected errors
            logger.exception("Unexpected error while polling Plex for PIN %s: %s", pin_id, exc)
            self._active_pins.pop(pin_id, None)
            self._clear_pin_state(status="error")
            raise PlexServiceError("Unable to verify Plex login.") from exc

        if not authorized:
            return {"status": "pending"}

        token = pin.token
        if not token:
            return {"status": "pending"}

        logger.info("Plex OAuth PIN %s authorized; storing credentials", pin_id)
        self._active_pins.pop(pin_id, None)
        pin.stop()

        account_info = self._finalize_connection(token)
        return {"status": "connected", "account": account_info}

    def disconnect(self) -> Dict[str, Any]:
        """Remove any persisted Plex credentials."""

        logger.info("Disconnecting Plex account and clearing stored token")
        for key, entry in list(self._active_pins.items()):
            try:
                entry.pin.stop()
            except Exception:  # pragma: no cover - best-effort cleanup
                logger.debug("Ignoring error while stopping Plex PIN %s during disconnect", key)
            self._active_pins.pop(key, None)
        self._update_settings({
            "status": "disconnected",
            "auth_token": None,
            "account": None,
            "pin_id": None,
            "pin_code": None,
            "pin_expires_at": None,
        })
        return {"status": "disconnected"}

    def get_account_snapshot(self) -> Dict[str, Any]:
        """Return the stored account metadata without revealing the token."""

        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        account = settings.get("account") or None
        status = settings.get("status") or "disconnected"
        last_connected_at = settings.get("last_connected_at")
        has_token = bool(settings.get("auth_token"))
        return {
            "status": status,
            "account": account,
            "last_connected_at": last_connected_at,
            "has_token": has_token,
        }

    def list_sections(self) -> Dict[str, Any]:
        """Return the available Plex library sections and server metadata."""

        _account, resource, server = self._connect_server()
        try:
            sections = server.library.sections()
        except Exception as exc:  # pragma: no cover - depends on Plex
            logger.exception("Failed to list Plex sections: %s", exc)
            raise PlexServiceError("Unable to load Plex library sections.") from exc

        return {
            "server": self._server_snapshot(resource, server),
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

        _account, resource, server = self._connect_server()

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
            "server": self._server_snapshot(resource, server),
            "section": self._serialize_section(section),
            "items": [self._serialize_item_overview(item) for item in items],
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

        _account, resource, server = self._connect_server()

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

        overview = self._serialize_item_overview(item)
        response = {
            "server": self._server_snapshot(resource, server),
            "item": overview,
            "media": self._serialize_media(item),
            "children": self._child_overviews(item),
        }
        return response

    def resolve_media_source(self, rating_key: Any, *, part_id: Optional[Any] = None) -> Dict[str, Any]:
        """Resolve a Plex item's media path for transcoding."""

        _account, _resource, server = self._connect_server()

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
            "item": self._serialize_item_overview(item),
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

        account, resource, server = self._connect_server()
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

    def _load_account(self) -> MyPlexAccount:
        token = self._get_token()
        session = self._create_session()
        try:
            return MyPlexAccount(token=token, session=session)
        except Exception as exc:  # pragma: no cover - relies on remote Plex API
            logger.exception("Failed to connect to Plex account: %s", exc)
            raise PlexServiceError("Unable to connect to Plex account.") from exc

    @staticmethod
    def _resource_machine_id(resource: MyPlexResource) -> Optional[str]:
        candidate = getattr(resource, "clientIdentifier", None) or getattr(resource, "machineIdentifier", None)
        if candidate:
            return str(candidate)
        device = getattr(resource, "device", None)
        return str(device) if device else None

    @staticmethod
    def _resource_provides(resource: MyPlexResource) -> set[str]:
        provides = getattr(resource, "provides", None)
        if not provides:
            return set()
        if isinstance(provides, str):
            return {part.strip() for part in provides.split(',') if part.strip()}
        if isinstance(provides, (list, tuple, set)):
            return {str(part).strip() for part in provides if str(part).strip()}
        return set()

    def _preferred_server_id(self) -> Optional[str]:
        settings = self._settings.get_system_settings(SettingsService.PLEX_NAMESPACE)
        server_info = settings.get("server")
        if isinstance(server_info, dict):
            machine_id = server_info.get("machine_identifier")
            if machine_id:
                return str(machine_id)
        return None

    def _persist_server(self, resource: MyPlexResource) -> None:
        connections: List[Dict[str, Any]] = []
        for conn in getattr(resource, "connections", []) or []:
            try:
                connections.append({
                    "uri": getattr(conn, "uri", None),
                    "address": getattr(conn, "address", None),
                    "port": getattr(conn, "port", None),
                    "local": getattr(conn, "local", None),
                    "relay": getattr(conn, "relay", None),
                    "public": getattr(conn, "public", None),
                    "protocol": getattr(conn, "protocol", None),
                    "dns": getattr(conn, "dns", None),
                })
            except Exception:  # pragma: no cover - defensive
                continue

        machine_id = self._resource_machine_id(resource)
        snapshot = {
            "name": getattr(resource, "name", None),
            "product": getattr(resource, "product", None),
            "platform": getattr(resource, "platform", None),
            "device": getattr(resource, "device", None),
            "machine_identifier": machine_id,
            "owned": getattr(resource, "owned", None),
            "provides": sorted(self._resource_provides(resource)),
            "connections": connections,
            "source_title": getattr(resource, "sourceTitle", None),
        }
        self._update_settings({"server": snapshot})

    def _connect_server(self, *, machine_identifier: Optional[str] = None) -> Tuple[MyPlexAccount, MyPlexResource, PlexServer]:
        account = self._load_account()
        preferred = machine_identifier or self._preferred_server_id()
        candidates: List[MyPlexResource] = []

        if preferred:
            try:
                resource = account.resource(preferred)
                if resource and "server" in self._resource_provides(resource):
                    candidates.append(resource)
            except NotFound:
                logger.warning("Preferred Plex server '%s' not found; falling back to available servers", preferred)

        if not candidates:
            for resource in account.resources():
                if "server" not in self._resource_provides(resource):
                    continue
                candidates.append(resource)

        for resource in candidates:
            try:
                session = self._create_session()
                server = resource.connect(timeout=10, session=session)
                self._persist_server(resource)
                return account, resource, server
            except Exception as exc:  # pragma: no cover - depends on Plex availability
                logger.warning(
                    "Failed to connect to Plex server '%s': %s",
                    getattr(resource, "name", self._resource_machine_id(resource) or "unknown"),
                    exc,
                )

        raise PlexServiceError("Unable to connect to a Plex server for the account.")

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

    def _server_snapshot(self, resource: MyPlexResource, server: PlexServer) -> Dict[str, Any]:
        connections: List[Dict[str, Any]] = []
        for conn in getattr(resource, "connections", []) or []:
            connections.append({
                "uri": getattr(conn, "uri", None),
                "address": getattr(conn, "address", None),
                "port": getattr(conn, "port", None),
                "local": getattr(conn, "local", None),
                "relay": getattr(conn, "relay", None),
                "public": getattr(conn, "public", None),
                "protocol": getattr(conn, "protocol", None),
                "dns": getattr(conn, "dns", None),
            })

        return {
            "name": getattr(resource, "name", None) or getattr(server, "friendlyName", None),
            "product": getattr(resource, "product", None),
            "platform": getattr(resource, "platform", None) or getattr(server, "platform", None),
            "version": getattr(server, "version", None),
            "machine_identifier": self._resource_machine_id(resource),
            "owned": getattr(resource, "owned", None),
            "provides": sorted(self._resource_provides(resource)),
            "connections": connections,
            "source_title": getattr(resource, "sourceTitle", None),
        }

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

    def _serialize_item_overview(self, item: Any) -> Dict[str, Any]:
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
            "playable": bool(item_type) and item_type in self.PLAYABLE_TYPES,
        }

        # Music-specific fields
        if item_type in {"track", "album", "artist"}:
            data.update({
                "album": getattr(item, "parentTitle", None),
                "artist": getattr(item, "grandparentTitle", None) or getattr(item, "parentTitle", None),
                "album_rating_key": getattr(item, "parentRatingKey", None),
                "artist_rating_key": getattr(item, "grandparentRatingKey", None),
            })

        if item_type in {"episode", "season", "show"}:
            data.update({
                "show_title": getattr(item, "grandparentTitle", None) or getattr(item, "parentTitle", None),
                "season_title": getattr(item, "parentTitle", None),
                "season_number": getattr(item, "parentIndex", None),
                "episode_number": getattr(item, "index", None),
            })

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
                children[key] = [self._serialize_item_overview(child) for child in results]

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

    def _clear_pin_state(self, *, status: Optional[str] = None) -> None:
        updates = {
            "pin_id": None,
            "pin_code": None,
            "pin_expires_at": None,
        }
        if status:
            updates["status"] = status
        self._update_settings(updates)

    def _finalize_connection(self, token: str) -> Dict[str, Any]:
        try:
            account = MyPlexAccount(token=token)
        except Exception as exc:  # pragma: no cover - network failures
            logger.exception("Unable to load Plex account details after OAuth: %s", exc)
            self._update_settings({
                "status": "error",
                "auth_token": None,
            })
            raise PlexServiceError("Authenticated with Plex but could not load account details.") from exc

        account_info = self._serialize_account(account)
        now = datetime.now(timezone.utc).isoformat()
        self._update_settings({
            "status": "connected",
            "auth_token": token,
            "account": account_info,
            "last_connected_at": now,
            "pin_id": None,
            "pin_code": None,
            "pin_expires_at": None,
        })
        return account_info

    @staticmethod
    def _serialize_account(account: MyPlexAccount) -> Dict[str, Any]:
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
