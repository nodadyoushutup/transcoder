"""Interfaces for publishing DASH segments to remote storage."""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import time
from typing import Dict, Iterable, Mapping, Optional, Tuple
from urllib.parse import urljoin

import shutil
import xml.etree.ElementTree as ET

import requests

from .exceptions import PublisherError


LOGGER = logging.getLogger(__name__)


class SegmentPublisher(ABC):
    """Abstract interface for delivering generated segments to a remote destination."""

    @abstractmethod
    def publish(
        self,
        mpd_path: Path,
        segment_paths: Iterable[Path],
        mpd_snapshot: Optional[Path] = None,
    ) -> None:
        """Upload the manifest and segments to a remote store."""

    def remove(self, segment_paths: Iterable[Path]) -> None:  # pragma: no cover - default no-op
        for _path in segment_paths:
            pass


class NoOpPublisher(SegmentPublisher):
    """Placeholder publisher that does nothing."""

    def publish(
        self,
        mpd_path: Path,
        segment_paths: Iterable[Path],
        mpd_snapshot: Optional[Path] = None,
    ) -> None:  # pragma: no cover - trivial
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

    def publish(
        self,
        mpd_path: Path,
        segment_paths: Iterable[Path],
        mpd_snapshot: Optional[Path] = None,
    ) -> None:
        for path in segment_paths:
            self._copy_path(path)

        manifest_source = Path(mpd_snapshot) if mpd_snapshot is not None else mpd_path
        self._copy_manifest(manifest_source, mpd_path)

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

    def _copy_manifest(self, source: Path, original: Path) -> None:
        destination = self._resolve_destination(original)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

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
    force_new_connection: bool = False
    wait_for_nonempty: float = 0.0
    wait_for_nonempty_poll: float = 0.05
    manifest_publish_delay: float = 0.0

    _session: requests.Session = field(init=False, repr=False)
    _headers: Mapping[str, str] = field(init=False, repr=False)
    _published_sequences: Dict[str, int] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        if not self.base_url.endswith('/'):
            self.base_url += '/'
        if self.source_root is not None:
            self.source_root = Path(self.source_root).expanduser().resolve()
        self._session = self.session or requests.Session()
        self._headers = dict(self.headers or {})
        if self.manifest_publish_delay < 0:
            LOGGER.warning(
                "Negative manifest_publish_delay %.3f provided; defaulting to 0",
                self.manifest_publish_delay,
            )
            self.manifest_publish_delay = 0.0

    def publish(
        self,
        mpd_path: Path,
        segment_paths: Iterable[Path],
        mpd_snapshot: Optional[Path] = None,
    ) -> None:
        # Upload newly generated segments *before* refreshing the manifest so
        # clients never see references to files that are still in flight.
        segments = list(segment_paths)
        if segments:
            LOGGER.info(
                "Publishing %d segment(s) to %s", len(segments), self.base_url
            )
        manifest_source = Path(mpd_snapshot) if mpd_snapshot is not None else mpd_path
        if not manifest_source.exists():
            raise PublisherError(f"Manifest source not found at {manifest_source}")

        for segment in segments:
            self._put_path(segment, self._infer_content_type(segment))
            self._note_segment_publish(segment)
        if segments and self.manifest_publish_delay > 0:
            LOGGER.debug(
                "Sleeping %.3f s before manifest publish to provide availability cushion",
                self.manifest_publish_delay,
            )
            time.sleep(self.manifest_publish_delay)
        self._validate_manifest(manifest_source)
        LOGGER.info(
            "Updating manifest %s using snapshot %s",
            mpd_path.name,
            manifest_source.name,
        )
        self._put_path(
            manifest_source,
            self.mpd_content_type,
            remote_path=mpd_path,
        )

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

    def _put_path(
        self,
        path: Path,
        content_type: str,
        *,
        remote_path: Optional[Path] = None,
    ) -> None:
        target_path = remote_path or path
        url = self._url_for(target_path)
        headers = dict(self._headers)
        headers.setdefault('Content-Type', content_type)
        if self.force_new_connection:
            headers.setdefault('Connection', 'close')
        size_bytes = self._await_publish_ready(path)
        stat_info = None
        mtime_iso = "?"
        age_ms: Optional[float] = None
        try:
            stat_info = path.stat()
        except OSError as exc:  # pragma: no cover - filesystem variance
            LOGGER.debug("Unable to stat %s prior to PUT: %s", path, exc)
        else:
            age_ms = max(0.0, (time.time() - stat_info.st_mtime) * 1000)
            mtime_iso = datetime.fromtimestamp(stat_info.st_mtime, tz=timezone.utc).isoformat()
        start = time.perf_counter()
        context_suffix = ""
        if stat_info is not None:
            context_suffix = f" (mtime={mtime_iso}, age_ms={age_ms:.2f})"
        LOGGER.info(
            "PUT %s (%s bytes) -> %s%s",
            target_path.name,
            size_bytes if size_bytes is not None else "?",
            url,
            context_suffix,
        )
        transport_session: requests.Session | None = None
        client = self._session
        if self.force_new_connection:
            transport_session = requests.Session()
            client = transport_session
        try:
            with path.open('rb') as handle:
                response = client.put(
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
        finally:
            if transport_session is not None:
                transport_session.close()
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
        age_display = f"{age_ms:.2f}" if age_ms is not None else "?"
        LOGGER.info(
            "PUT %s completed in %.2f ms (%s bytes) [age_start_ms=%s]",
            url,
            duration_ms,
            size_bytes if size_bytes is not None else "?",
            age_display,
        )

    def _url_for(self, path: Path) -> str:
        key = self._relative_key(path)
        return urljoin(self.base_url, key)

    def _note_segment_publish(self, path: Path) -> None:
        rep_id, sequence = self._segment_metadata(path)
        if rep_id is None or sequence is None:
            return
        previous = self._published_sequences.get(rep_id)
        if previous is None or sequence > previous:
            self._published_sequences[rep_id] = sequence

    def _segment_metadata(self, path: Path) -> Tuple[Optional[str], Optional[int]]:
        name = path.name
        if name.startswith('chunk-'):
            remainder = name[6:]
            rep_part, _, tail = remainder.partition('-')
            if not rep_part or not tail:
                return None, None
            number_str, _, _ = tail.partition('.')
            if not number_str:
                return None, None
        elif '_chunk_' in name:
            try:
                remainder = name.split('_chunk_', 1)[1]
            except IndexError:
                return None, None
            rep_part, _, tail = remainder.partition('_')
            if not rep_part or not tail:
                return None, None
            number_str, _, _ = tail.partition('.')
            if not number_str:
                return None, None
        else:
            return None, None

        try:
            return rep_part, int(number_str)
        except ValueError:
            return None, None

    def _validate_manifest(self, mpd_path: Path) -> None:
        requirements = self._manifest_max_requirements(mpd_path)
        if not requirements:
            LOGGER.debug("Manifest guard skipped; no segment requirements parsed from %s", mpd_path)
            return

        violators = []
        for rep_id, required_seq in requirements.items():
            published = self._published_sequences.get(rep_id)
            if published is None or published < required_seq:
                violators.append((rep_id, required_seq, published))

        if violators:
            details = ", ".join(
                f"rep={rep_id} required={required} published={published if published is not None else 'none'}"
                for rep_id, required, published in violators
            )
            LOGGER.error(
                "Manifest %s references segments beyond published window: %s",
                mpd_path,
                details,
            )
            raise PublisherError(
                f"Manifest references unpublished segments: {details}"
            )

        LOGGER.debug(
            "Manifest %s validated against published segments: %s",
            mpd_path,
            {rep: self._published_sequences.get(rep) for rep in requirements},
        )

    def _manifest_max_requirements(self, mpd_path: Path) -> Dict[str, int]:
        try:
            tree = ET.parse(mpd_path)
        except ET.ParseError as exc:
            LOGGER.warning("Unable to parse manifest %s for guard check: %s", mpd_path, exc)
            return {}

        root = tree.getroot()
        namespace = self._extract_namespace(root.tag)
        if namespace is None:
            LOGGER.debug("Unable to determine namespace for manifest %s", mpd_path)
            return {}
        ns = {'mpd': namespace}

        requirements: Dict[str, int] = {}
        for representation in root.findall('.//mpd:Representation', ns):
            rep_id = representation.attrib.get('id')
            if not rep_id:
                continue
            segment_template = representation.find('mpd:SegmentTemplate', ns)
            if segment_template is None:
                continue
            start_number = segment_template.attrib.get('startNumber')
            try:
                next_number = int(start_number) if start_number is not None else 1
            except ValueError:
                next_number = 1
            timeline = segment_template.find('mpd:SegmentTimeline', ns)
            if timeline is None:
                LOGGER.debug(
                    "Manifest %s representation %s missing SegmentTimeline; guard skipped for this representation",
                    mpd_path,
                    rep_id,
                )
                continue
            segments = 0
            for segment in timeline.findall('mpd:S', ns):
                repeat = segment.attrib.get('r')
                try:
                    repeat_count = int(repeat) if repeat is not None else 0
                except ValueError:
                    repeat_count = 0
                segments += repeat_count + 1
            if segments == 0:
                continue
            highest = next_number + segments - 1
            requirements[rep_id] = highest

        return requirements

    def _extract_namespace(self, tag: str) -> Optional[str]:
        if tag.startswith('{') and '}' in tag:
            return tag[1: tag.index('}')]
        return None

    def _await_publish_ready(self, path: Path) -> Optional[int]:
        deadline: Optional[float] = None
        if self.wait_for_nonempty > 0:
            deadline = time.perf_counter() + self.wait_for_nonempty

        last_error: Optional[BaseException] = None
        while True:
            try:
                size = path.stat().st_size
            except OSError as exc:
                last_error = exc
                size = None
            else:
                if size and size > 0:
                    return size
                if size == 0 and self.wait_for_nonempty <= 0:
                    raise PublisherError(f"Refusing to publish empty file {path}")

            if self.wait_for_nonempty <= 0:
                if last_error is not None:
                    raise PublisherError(f"Unable to stat {path}: {last_error}") from last_error
                raise PublisherError(f"Refusing to publish empty file {path}")

            now = time.perf_counter()
            if deadline is not None and now >= deadline:
                if last_error is not None:
                    raise PublisherError(f"Unable to stat {path}: {last_error}") from last_error
                raise PublisherError(
                    f"Refusing to publish empty file {path} after waiting {self.wait_for_nonempty:.3f}s"
                )

            sleep_for = self.wait_for_nonempty_poll
            if deadline is not None:
                sleep_for = min(sleep_for, max(0.0, deadline - now))
            if sleep_for > 0:
                time.sleep(sleep_for)


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
