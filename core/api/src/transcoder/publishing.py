"""Interfaces for publishing DASH segments to remote storage."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
import logging
from pathlib import Path
import time
from typing import Iterable, Mapping, Optional
from urllib.parse import urljoin

import shutil

import requests

from .exceptions import PublisherError


LOGGER = logging.getLogger(__name__)


class SegmentPublisher(ABC):
    """Abstract interface for delivering generated segments to a remote destination."""

    @abstractmethod
    def publish(self, mpd_path: Path, segment_paths: Iterable[Path]) -> None:
        """Upload the manifest and segments to a remote store."""

    def remove(self, segment_paths: Iterable[Path]) -> None:  # pragma: no cover - default no-op
        for _path in segment_paths:
            pass


class NoOpPublisher(SegmentPublisher):
    """Placeholder publisher that does nothing."""

    def publish(self, mpd_path: Path, segment_paths: Iterable[Path]) -> None:  # pragma: no cover - trivial
        try:
            for _segment in segment_paths:
                pass
        except Exception as exc:  # pragma: no cover - defensive
            raise PublisherError("Unexpected failure while iterating segment paths") from exc


@dataclass(slots=True)
class LocalPublisher(SegmentPublisher):
    """Copy manifests and segments into a target directory on the local filesystem."""

    target_dir: Path
    source_root: Optional[Path] = None
    overwrite: bool = True

    def __post_init__(self) -> None:
        self.target_dir = Path(self.target_dir).expanduser().resolve()
        if self.source_root is not None:
            self.source_root = Path(self.source_root).expanduser().resolve()

    def publish(self, mpd_path: Path, segment_paths: Iterable[Path]) -> None:
        paths = [mpd_path, *segment_paths]
        for path in paths:
            self._copy_path(path)

    def remove(self, segment_paths: Iterable[Path]) -> None:
        for src in segment_paths:
            destination = self._resolve_destination(src)
            try:
                if destination.exists():
                    destination.unlink()
            except OSError as exc:  # pragma: no cover - filesystem variance
                raise PublisherError(f"Failed to remove local copy for {destination}") from exc

    def _copy_path(self, src: Path) -> None:
        destination = self._resolve_destination(src)
        if destination.exists() and not self.overwrite:
            return
        if destination.exists() and destination.resolve() == src.resolve():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, destination)

    def _resolve_destination(self, src: Path) -> Path:
        if self.source_root is not None:
            try:
                relative = src.resolve().relative_to(self.source_root)
            except ValueError:
                relative = Path(src.name)
        else:
            relative = Path(src.name)
        return self.target_dir / relative


@dataclass(slots=True)
class HttpPutPublisher(SegmentPublisher):
    """Upload manifests and segments to a remote endpoint via HTTP PUT."""

    base_url: str
    source_root: Optional[Path] = None
    headers: Optional[Mapping[str, str]] = None
    timeout: float = 30.0
    verify: bool | str = True
    session: Optional[requests.Session] = None
    mpd_content_type: str = "application/dash+xml"
    segment_content_type: str = "application/octet-stream"
    enable_delete: bool = False

    _session: requests.Session = field(init=False, repr=False)
    _headers: Mapping[str, str] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not self.base_url.endswith('/'):
            self.base_url += '/'
        if self.source_root is not None:
            self.source_root = Path(self.source_root).expanduser().resolve()
        self._session = self.session or requests.Session()
        self._headers = dict(self.headers or {})

    def publish(self, mpd_path: Path, segment_paths: Iterable[Path]) -> None:
        # Upload newly generated segments *before* refreshing the manifest so
        # clients never see references to files that are still in flight.
        segments = list(segment_paths)
        if segments:
            LOGGER.info(
                "Publishing %d segment(s) to %s", len(segments), self.base_url
            )
        for segment in segments:
            self._put_path(segment, self._infer_content_type(segment))
        LOGGER.info("Updating manifest %s", mpd_path.name)
        self._put_path(mpd_path, self.mpd_content_type)

    def remove(self, segment_paths: Iterable[Path]) -> None:
        if not self.enable_delete:
            return
        for path in segment_paths:
            url = self._url_for(path)
            try:
                response = self._session.delete(
                    url, headers=dict(self._headers), timeout=self.timeout, verify=self.verify
                )
            except requests.RequestException as exc:  # pragma: no cover - network dependent
                raise PublisherError(f'Failed to DELETE {url}: {exc}') from exc
            if response.status_code >= 400 and response.status_code != 404:
                preview = response.text[:200]
                raise PublisherError(
                    f"Failed to DELETE {url}: status={response.status_code} body={preview!r}"
                )

    def _put_path(self, path: Path, content_type: str) -> None:
        url = self._url_for(path)
        headers = dict(self._headers)
        headers.setdefault('Content-Type', content_type)
        size_bytes: Optional[int] = None
        try:
            size_bytes = path.stat().st_size
        except OSError:
            size_bytes = None
        start = time.perf_counter()
        LOGGER.info(
            "PUT %s (%s bytes) -> %s", path.name, size_bytes if size_bytes is not None else "?", url
        )
        try:
            with path.open('rb') as handle:
                response = self._session.put(
                    url,
                    data=handle,
                    headers=headers,
                    timeout=self.timeout,
                    verify=self.verify,
                )
        except requests.RequestException as exc:  # pragma: no cover - network dependent
            duration_ms = (time.perf_counter() - start) * 1000
            LOGGER.error(
                "PUT %s failed after %.2f ms: %s",
                url,
                duration_ms,
                exc,
            )
            raise PublisherError(f'Failed to PUT {url}: {exc}') from exc
        if response.status_code >= 400:
            preview = response.text[:200]
            duration_ms = (time.perf_counter() - start) * 1000
            LOGGER.error(
                "PUT %s failed with status %s after %.2f ms: %r",
                url,
                response.status_code,
                duration_ms,
                preview,
            )
            raise PublisherError(
                f"Failed to PUT {url}: status={response.status_code} body={preview!r}"
            )
        duration_ms = (time.perf_counter() - start) * 1000
        LOGGER.info(
            "PUT %s completed in %.2f ms (%s bytes)",
            url,
            duration_ms,
            size_bytes if size_bytes is not None else "?",
        )

    def _url_for(self, path: Path) -> str:
        key = self._relative_key(path)
        return urljoin(self.base_url, key)

    def _relative_key(self, path: Path) -> str:
        if self.source_root is not None:
            try:
                relative = path.resolve().relative_to(self.source_root)
                return '/'.join(relative.parts)
            except ValueError:
                pass
        return path.name

    def _infer_content_type(self, path: Path) -> str:
        extension = path.suffix.lower()
        if extension == '.mpd':
            return self.mpd_content_type
        if extension in {'.m4s', '.m4v'}:
            return 'video/iso.segment'
        if extension in {'.mp4', '.m4a'}:
            return 'video/mp4'
        if extension in {'.aac'}:
            return 'audio/aac'
        return self.segment_content_type
