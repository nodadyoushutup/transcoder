"""WebDAV storage helpers used by the transcoder uploader."""
from __future__ import annotations

import logging
from pathlib import Path
from threading import Lock
from typing import Optional
from urllib.parse import quote

import requests

from ..utils import sleep_with_stop, strip_trailing_slash

LOGGER = logging.getLogger(__name__)


class WebDavStorage:
    """Encapsulate WebDAV interactions and retry logic."""

    def __init__(
        self,
        *,
        upload_base: str,
        headers: Optional[dict[str, str]] = None,
        request_timeout: float,
        retry_attempts: int,
        retry_backoff: float,
        session: Optional[requests.Session] = None,
    ) -> None:
        if not upload_base:
            raise ValueError("upload_base must be provided")

        self.upload_base = self._normalize_base(upload_base)
        self.headers = dict(headers or {})
        self.request_timeout = max(1.0, request_timeout)
        self.retry_attempts = max(1, retry_attempts)
        self.retry_backoff = max(1.0, retry_backoff)
        self._session = session or requests.Session()
        self._known_directories: set[Path] = set()
        self._lock = Lock()

    def close(self) -> None:
        self._session.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def upload_file(self, *, kind: str, path: Path, relative: Path, stop_event) -> None:
        if stop_event.is_set():
            LOGGER.debug("Skipping %s upload for %s: stop requested", kind, relative)
            return
        if not path.exists():
            LOGGER.warning("Skipping %s upload; path no longer exists: %s", kind, path)
            return
        if path.is_dir():
            LOGGER.debug("Skipping directory %s", path)
            return

        try:
            self._ensure_remote_directories(relative.parent, stop_event)
        except Exception as exc:
            LOGGER.warning("Unable to prepare remote path for %s: %s", relative, exc)

        url = self._compose_url(relative)
        attempt = 1
        backoff = self.retry_backoff
        while attempt <= self.retry_attempts and not stop_event.is_set():
            try:
                with path.open("rb") as fh:
                    response = self._session.put(
                        url,
                        headers=self.headers,
                        data=fh,
                        timeout=self.request_timeout,
                    )
                if 200 <= response.status_code < 300:
                    LOGGER.info("[%s] %s (%d)", kind.upper(), relative.as_posix(), response.status_code)
                    return
                LOGGER.warning(
                    "[%s] %s failed (status=%d)",
                    kind.upper(),
                    relative.as_posix(),
                    response.status_code,
                )
            except requests.RequestException as exc:
                LOGGER.warning("[%s] %s upload error: %s", kind.upper(), relative.as_posix(), exc)

            attempt += 1
            if attempt <= self.retry_attempts:
                sleep_for = min(backoff, 10.0)
                LOGGER.debug("Retrying %s upload for %s in %.1fs", kind, relative, sleep_for)
                sleep_with_stop(sleep_for, stop_event)
                backoff *= self.retry_backoff

        LOGGER.error("[%s] %s failed after %d attempt(s)", kind.upper(), relative.as_posix(), self.retry_attempts)

    def delete_path(self, relative: Path, *, is_directory: bool, stop_event) -> None:
        if stop_event.is_set():
            LOGGER.debug("Skipping delete for %s: stop requested", relative)
            return

        url = self._compose_url(relative)
        attempt = 1
        backoff = self.retry_backoff
        while attempt <= self.retry_attempts and not stop_event.is_set():
            try:
                response = self._session.delete(
                    url,
                    headers=self.headers,
                    timeout=self.request_timeout,
                )
                if response.status_code in (200, 202, 204, 404):
                    LOGGER.info("[DELETE] %s (%d)", relative.as_posix(), response.status_code)
                    if is_directory:
                        self._evict_known_directory(relative)
                    return
                LOGGER.warning(
                    "[DELETE] %s failed (status=%d)",
                    relative.as_posix(),
                    response.status_code,
                )
            except requests.RequestException as exc:
                LOGGER.warning("[DELETE] %s error: %s", relative.as_posix(), exc)

            attempt += 1
            if attempt <= self.retry_attempts:
                sleep_for = min(backoff, 10.0)
                LOGGER.debug("Retrying delete for %s in %.1fs", relative, sleep_for)
                sleep_with_stop(sleep_for, stop_event)
                backoff *= self.retry_backoff

        LOGGER.error("[DELETE] %s failed after %d attempt(s)", relative.as_posix(), self.retry_attempts)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _ensure_remote_directories(self, relative_parent: Path, stop_event) -> None:
        if not relative_parent or relative_parent == Path(".") or stop_event.is_set():
            return
        parts = list(relative_parent.parts)
        accumulated = Path()
        for part in parts:
            accumulated = accumulated / part
            with self._lock:
                if accumulated in self._known_directories:
                    continue
            url = self._compose_url(accumulated)
            try:
                response = self._session.request(
                    "MKCOL",
                    url,
                    headers=self.headers,
                    timeout=self.request_timeout,
                )
            except requests.RequestException as exc:
                LOGGER.debug("MKCOL %s failed: %s", url, exc)
                continue
            if response.status_code in (200, 201, 204, 405, 409):
                with self._lock:
                    self._known_directories.add(accumulated)
                continue
            LOGGER.debug(
                "MKCOL %s returned unexpected status %s",
                url,
                response.status_code,
            )

    def _evict_known_directory(self, relative: Path) -> None:
        with self._lock:
            snapshot = list(self._known_directories)
        to_remove = []
        for known in snapshot:
            if known == relative:
                to_remove.append(known)
                continue
            try:
                known.relative_to(relative)
                to_remove.append(known)
            except ValueError:
                continue
        if not to_remove:
            return
        with self._lock:
            for entry in to_remove:
                self._known_directories.discard(entry)

    def _compose_url(self, relative: Path) -> str:
        safe_path = "/".join(quote(part) for part in relative.parts if part)
        if safe_path:
            return f"{self.upload_base}/{safe_path}"
        return self.upload_base

    @staticmethod
    def _normalize_base(url: str) -> str:
        trimmed = strip_trailing_slash(url or "")
        if not trimmed:
            raise ValueError("upload base URL cannot be empty")
        return trimmed


__all__ = ["WebDavStorage"]
