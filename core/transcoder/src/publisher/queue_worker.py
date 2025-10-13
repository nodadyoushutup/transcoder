"""Background upload queue that coordinates WebDAV operations."""
from __future__ import annotations

import copy
import logging
import re
import time
import xml.etree.ElementTree as ET
import heapq
import threading

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Condition, Event, Lock
from typing import Iterable, Optional

from ..utils import sleep_with_stop
from .storage import WebDavStorage

LOGGER = logging.getLogger("transcoder.publisher.queue")


class UploadManager:
    """Coordinate manifest and segment uploads via a worker pool."""

    MANIFEST_EXTENSIONS = {".mpd", ".m3u8"}
    PACKAGER_TEMP_PREFIX = "packager-tempfile-"

    def __init__(
        self,
        *,
        output_dir: Path,
        storage: WebDavStorage,
        manifest_delay: float,
        manifest_timeout: float,
        max_workers: int,
        delete_workers: Optional[int] = None,
        stop_event: Optional[Event] = None,
    ) -> None:
        self.output_dir = output_dir.expanduser().resolve()
        self.storage = storage
        self.manifest_delay = max(0.0, manifest_delay)
        self.manifest_timeout = max(1.0, manifest_timeout)
        self.stop_event = stop_event or Event()

        self._executor = ThreadPoolExecutor(max_workers=max(1, max_workers))
        delete_worker_count = delete_workers if delete_workers is not None else 1
        if delete_worker_count < 0:
            raise ValueError("delete_workers cannot be negative")
        self._delete_executor = (
            ThreadPoolExecutor(max_workers=max(1, delete_worker_count))
            if delete_worker_count
            else None
        )
        self._lock = Lock()
        self._condition = Condition(self._lock)
        self._segment_sequence = 0
        self._inflight_segments: dict[int, Path] = {}
        self._segment_sessions: dict[int, str] = {}
        self._session_state: dict[str, bool] = {}
        self._session_allowlist: Optional[set[str]] = None
        self._retry_base_delay = 1.0
        self._retry_backoff_factor = max(1.0, getattr(self.storage, "retry_backoff", 1.5))
        self._retry_max_delay = 30.0
        self._delete_delay = 120.0
        self._pending_deletes: list[tuple[float, Path, bool]] = []
        self._delete_wakeup = Event()
        self._delete_thread = threading.Thread(
            target=self._delete_worker,
            name="upload-delete-delay",
            daemon=True,
        )
        self._delete_thread.start()

        LOGGER.info(
            "Upload manager initialised (output=%s workers=%d)",
            self.output_dir,
            max(1, max_workers),
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        LOGGER.debug("Upload manager shutting down")
        self.stop_event.set()
        self._delete_wakeup.set()
        self._executor.shutdown(wait=True, cancel_futures=True)
        if self._delete_executor:
            self._delete_executor.shutdown(wait=True, cancel_futures=True)
        if self._delete_thread.is_alive():
            self._delete_thread.join(timeout=2.0)
        self.storage.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def submit(self, path: Path) -> None:
        try:
            relative = path.relative_to(self.output_dir)
        except ValueError:
            LOGGER.debug("Skipping %s: outside of output dir %s", path, self.output_dir)
            return

        if ".pipes" in relative.parts:
            LOGGER.debug("Skipping pipe artifact %s", relative)
            return

        session_id = self._extract_session_id(relative)
        if session_id:
            if not self._is_session_allowed(session_id):
                LOGGER.debug("Skipping %s: session %s filtered", relative, session_id)
                return
            self._mark_session_active(session_id)
            if self._is_session_inactive(session_id):
                LOGGER.debug("Skipping %s: session %s inactive", relative, session_id)
                return

        suffix = path.suffix.lower()
        if suffix in self.MANIFEST_EXTENSIONS:
            if self._is_packager_temp(relative):
                LOGGER.debug("Skipping packager temp manifest %s", relative)
                return
            marker = self._current_segment_marker()
            LOGGER.debug("Scheduling manifest upload for %s (marker=%d)", relative, marker)
            self._executor.submit(self._upload_manifest, path, relative, marker, session_id)
            return

        if suffix == ".tmp":
            LOGGER.debug("Skipping temp file %s", relative)
            return

        if self._is_packager_temp(relative):
            LOGGER.debug("Skipping packager temp file %s", relative)
            return

        token = self._register_segment(relative, session_id)
        LOGGER.debug("Scheduling segment upload for %s (token=%d)", relative, token)
        self._executor.submit(self._upload_segment, path, relative, token, session_id)

    def delete(self, path: Path, *, is_directory: bool) -> None:
        try:
            relative = path.relative_to(self.output_dir)
        except ValueError:
            LOGGER.debug("Skipping delete for %s: outside of output dir %s", path, self.output_dir)
            return

        if not relative.parts:
            LOGGER.debug("Skipping delete for root output directory %s", path)
            return

        if not is_directory and relative.suffix.lower() == ".tmp":
            LOGGER.debug("Skipping delete for temp file %s", relative)
            return

        LOGGER.debug(
            "Scheduling %s delete for %s",
            "directory" if is_directory else "file",
            relative,
        )
        session_id = self._extract_session_id(relative)
        if session_id and not self._is_session_allowed(session_id):
            LOGGER.debug("Skipping delete for %s: session %s filtered", relative, session_id)
            return
        if session_id and is_directory and self._is_session_directory(relative):
            self._mark_session_inactive(session_id)
        elif session_id and is_directory and self._is_session_pipes_directory(relative):
            self._mark_session_inactive(session_id)

        deadline = time.monotonic() + self._delete_delay
        with self._condition:
            heapq.heappush(self._pending_deletes, (deadline, path, is_directory))
            self._delete_wakeup.set()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _upload_segment(self, path: Path, relative: Path, token: int, session_id: Optional[str]) -> None:
        if self._is_session_inactive(session_id):
            LOGGER.debug("Skipping segment upload for %s: session inactive", relative)
            return
        attempts = 0
        uploaded = False
        try:
            while not self.stop_event.is_set():
                if self._is_session_inactive(session_id):
                    LOGGER.debug("Aborting segment upload for %s: session inactive", relative)
                    break
                attempts += 1
                uploaded = self.storage.upload_file(
                    kind="segment",
                    path=path,
                    relative=relative,
                    stop_event=self.stop_event,
                )
                if uploaded:
                    break
                if not path.exists():
                    LOGGER.warning(
                        "Segment disappeared before upload succeeded: %s",
                        relative,
                    )
                    break
                delay = self._next_retry_delay(attempts)
                LOGGER.warning(
                    "Segment upload failed; retrying in %.1fs (cycle=%d, %s)",
                    delay,
                    attempts,
                    relative,
                )
                self._sleep_with_stop(delay)
        finally:
            if not uploaded and not self.stop_event.is_set():
                LOGGER.warning(
                    "Segment upload exhausted after %d cycle(s); giving up on %s",
                    attempts,
                    relative,
                )
            with self._condition:
                self._inflight_segments.pop(token, None)
                if session_id:
                    self._segment_sessions.pop(token, None)
                self._condition.notify_all()

    def _upload_manifest(self, path: Path, relative: Path, marker: int, session_id: Optional[str]) -> None:
        if self._is_session_inactive(session_id):
            LOGGER.debug("Skipping manifest upload for %s: session inactive", relative)
            return
        LOGGER.debug("Waiting %.2fs before manifest upload for %s", self.manifest_delay, relative)
        self._sleep_with_stop(self.manifest_delay)
        self._await_segments(marker)
        attempts = 0
        uploaded = False
        while not self.stop_event.is_set():
            if self._is_session_inactive(session_id):
                LOGGER.debug("Aborting manifest upload for %s: session inactive", relative)
                break
            attempts += 1
            if not self._ensure_segment_presence(path):
                LOGGER.debug("Segment prerequisites missing for %s; retrying manifest upload loop", relative)
                attempts -= 1
                continue
            try:
                _augment_manifest_with_subtitles(path)
            except Exception:  # pragma: no cover - defensive
                LOGGER.warning("Unable to augment manifest %s with subtitles", relative, exc_info=True)
            uploaded = self.storage.upload_file(
                kind="manifest",
                path=path,
                relative=relative,
                stop_event=self.stop_event,
            )
            if uploaded:
                break
            if not path.exists():
                LOGGER.warning(
                    "Manifest no longer present; aborting upload for %s",
                    relative,
                )
                break
            delay = self._next_retry_delay(attempts)
            LOGGER.warning(
                "Manifest upload failed; retrying in %.1fs (cycle=%d, %s)",
                delay,
                attempts,
                relative,
            )
            self._sleep_with_stop(delay)
        if not uploaded and not self.stop_event.is_set():
            LOGGER.warning(
                "Manifest upload exhausted after %d cycle(s); giving up on %s",
                attempts,
                relative,
            )

    def _register_segment(self, relative: Path, session_id: Optional[str]) -> int:
        with self._condition:
            self._segment_sequence += 1
            token = self._segment_sequence
            self._inflight_segments[token] = relative
            if session_id:
                self._segment_sessions[token] = session_id
            return token

    def _current_segment_marker(self) -> int:
        with self._condition:
            return self._segment_sequence

    def _await_segments(self, marker: int) -> None:
        deadline = time.monotonic() + self.manifest_timeout
        with self._condition:
            while any(token <= marker for token in self._inflight_segments):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.stop_event.is_set():
                    LOGGER.warning(
                        "Manifest wait timed out (marker=%d inflight=%d)",
                        marker,
                        len(self._inflight_segments),
                    )
                    break
                self._condition.wait(timeout=min(remaining, 0.5))

    def _is_packager_temp(self, relative: Path) -> bool:
        return any(part.startswith(self.PACKAGER_TEMP_PREFIX) for part in relative.parts)

    def _sleep_with_stop(self, seconds: float) -> None:
        sleep_with_stop(seconds, self.stop_event)

    def _next_retry_delay(self, cycle: int) -> float:
        scale = max(1, cycle)
        delay = self._retry_base_delay * (self._retry_backoff_factor ** (scale - 1))
        return min(delay, self._retry_max_delay)

    def _extract_session_id(self, relative: Path) -> Optional[str]:
        parts = relative.parts
        if len(parts) >= 2 and parts[0] == "sessions":
            return parts[1]
        return None

    def _is_session_directory(self, relative: Path) -> bool:
        parts = relative.parts
        return len(parts) == 2 and parts[0] == "sessions"

    def _is_session_pipes_directory(self, relative: Path) -> bool:
        parts = relative.parts
        return (
            len(parts) == 3
            and parts[0] == "sessions"
            and parts[2] == ".pipes"
        )

    def _mark_session_active(self, session_id: str) -> None:
        with self._condition:
            self._session_state[session_id] = True

    def _mark_session_inactive(self, session_id: str) -> None:
        with self._condition:
            if self._session_state.get(session_id) is False:
                return
            self._session_state[session_id] = False
            stale_tokens = [
                token
                for token, token_session in self._segment_sessions.items()
                if token_session == session_id
            ]
            for token in stale_tokens:
                self._inflight_segments.pop(token, None)
                self._segment_sessions.pop(token, None)
            if stale_tokens:
                self._condition.notify_all()

    def _is_session_inactive(self, session_id: Optional[str]) -> bool:
        if not session_id:
            return False
        with self._condition:
            allowlist = self._session_allowlist
            if allowlist is not None and session_id not in allowlist:
                return True
            return self._session_state.get(session_id) is False

    def update_session_allowlist(self, sessions: Optional[Iterable[str]]) -> None:
        allowlist: Optional[set[str]] = None
        if sessions is not None:
            allowlist = {str(session).strip() for session in sessions if str(session).strip()}
        with self._condition:
            previous = self._session_allowlist
            self._session_allowlist = allowlist
            if allowlist is not None:
                for session_id in list(self._session_state.keys()):
                    if session_id not in allowlist:
                        self._session_state[session_id] = False
                # Drop any pending deletes that target filtered sessions so they don't
                # continue to hammer the remote storage after a session switch.
                updated_deletes: list[tuple[float, Path, bool]] = []
                removed = 0
                for deadline, pending_path, is_dir in self._pending_deletes:
                    try:
                        relative = pending_path.relative_to(self.output_dir)
                    except ValueError:
                        updated_deletes.append((deadline, pending_path, is_dir))
                        continue
                    session = self._extract_session_id(relative)
                    if session and session not in allowlist:
                        removed += 1
                        continue
                    updated_deletes.append((deadline, pending_path, is_dir))
                if removed:
                    heapq.heapify(updated_deletes)
                    self._pending_deletes = updated_deletes
                    LOGGER.info(
                        "Discarded %d pending delete(s) for inactive sessions",
                        removed,
                    )
                self._condition.notify_all()
        if allowlist is None and previous is not None:
            LOGGER.info("Watchdog session filter cleared")
        elif allowlist is not None and allowlist != previous:
            descriptor = ", ".join(sorted(allowlist)) or "(none)"
            LOGGER.info("Watchdog session filter updated: %s", descriptor)

    def _is_session_allowed(self, session_id: Optional[str]) -> bool:
        if not session_id:
            return True
        with self._condition:
            allowlist = self._session_allowlist
            return allowlist is None or session_id in allowlist

    def _delete_worker(self) -> None:
        while not self.stop_event.is_set():
            with self._condition:
                while not self._pending_deletes and not self.stop_event.is_set():
                    self._delete_wakeup.clear()
                    self._condition.wait(timeout=1.0)
                if self.stop_event.is_set():
                    break
                deadline, path, is_directory = heapq.heappop(self._pending_deletes)
            now = time.monotonic()
            if deadline > now:
                if self.stop_event.wait(min(deadline - now, 5.0)):
                    break
                with self._condition:
                    heapq.heappush(self._pending_deletes, (deadline, path, is_directory))
                continue
            try:
                relative = path.relative_to(self.output_dir)
            except ValueError:
                continue
            if self.stop_event.is_set():
                break
            if self._delete_executor:
                self._delete_executor.submit(
                    self.storage.delete_path,
                    relative,
                    is_directory=is_directory,
                    stop_event=self.stop_event,
                )
            else:
                self.storage.delete_path(
                    relative,
                    is_directory=is_directory,
                    stop_event=self.stop_event,
                )

    def _ensure_segment_presence(self, manifest_path: Path) -> bool:
        max_wait_seconds = 60.0
        poll_interval = 0.5
        start = time.monotonic()
        warned = False
        while not self.stop_event.is_set():
            missing: list[Path] = []
            for candidate in _missing_segment_paths(manifest_path):
                if not candidate.exists():
                    missing.append(candidate)
                    continue
                try:
                    relative = candidate.relative_to(self.output_dir)
                except ValueError:
                    missing.append(candidate)
                    continue
                if not self.storage.remote_exists(relative):
                    missing.append(candidate)
            if not missing:
                if warned:
                    LOGGER.info("Manifest %s initial segments now available", manifest_path)
                return True

            elapsed = time.monotonic() - start
            if elapsed >= max_wait_seconds and not warned:
                LOGGER.warning(
                    "Manifest %s still waiting for initial segments after %.1fs (%s)",
                    manifest_path,
                    elapsed,
                    ", ".join(str(path.name) for path in missing[:4]) or "none",
                )
                warned = True
            self._sleep_with_stop(poll_interval)

        return False


__all__ = ["UploadManager"]


def _augment_manifest_with_subtitles(manifest_path: Path) -> None:
    if not manifest_path.exists():
        return

    session_dir = manifest_path.parent
    subtitle_tracks = _discover_subtitle_tracks(session_dir)
    if not subtitle_tracks:
        return

    tree = ET.parse(manifest_path)
    root = tree.getroot()
    if root is None:
        return
    ns_uri, _, tag_name = root.tag[1:].partition("}")
    if not tag_name:
        return
    ns = {"mpd": ns_uri}
    period = root.find("mpd:Period", ns)
    if period is None:
        return

    existing_text = period.findall("mpd:AdaptationSet[@contentType='text']", ns)
    existing_langs = {adapt.get("lang") for adapt in existing_text if adapt.get("lang")}
    template_source = _select_reference_template(period, ns)
    if template_source is None:
        return
    added_track = False

    for language, start_number in subtitle_tracks.items():
        lang_code = language.lower()
        if lang_code in existing_langs:
            continue
        _append_text_adaptation(
            period=period,
            ns_uri=ns_uri,
            template_source=template_source,
            language=lang_code,
            start_number=start_number,
        )
        existing_langs.add(lang_code)
        added_track = True

    if added_track:
        tree.write(manifest_path, encoding="utf-8", xml_declaration=True)


def _discover_subtitle_tracks(session_dir: Path) -> dict[str, int]:
    tracks: dict[str, int] = {}
    for candidate in session_dir.glob("text_*_*.vtt"):
        match = re.fullmatch(r"text_([A-Za-z0-9]+)_([0-9]+)\.vtt", candidate.name)
        if not match:
            continue
        language = match.group(1).lower()
        number = int(match.group(2))
        current = tracks.get(language)
        if current is None or number < current:
            tracks[language] = number
    return tracks


def _missing_segment_paths(manifest_path: Path) -> list[Path]:
    if not manifest_path.exists():
        return []
    try:
        tree = ET.parse(manifest_path)
    except ET.ParseError:
        return []
    root = tree.getroot()
    if root is None:
        return []
    ns_uri, _, tag_name = root.tag[1:].partition("}")
    if not tag_name:
        return []
    ns = {"mpd": ns_uri}
    period = root.find("mpd:Period", ns)
    if period is None:
        return []
    missing: list[Path] = []
    for adaptation in period.findall("mpd:AdaptationSet", ns):
        template = adaptation.find("mpd:Representation/mpd:SegmentTemplate", ns)
        if template is None:
            continue
        media = template.get("media")
        start_number = template.get("startNumber")
        if not media or not start_number:
            continue
        try:
            number = int(start_number)
        except ValueError:
            continue
        media_name = _apply_number_placeholder(media, number)
        if not media_name:
            continue
        candidate = manifest_path.parent / media_name
        if not candidate.exists():
            missing.append(candidate)
    return missing


def _apply_number_placeholder(template: str, number: int) -> Optional[str]:
    if "$Number%05d$" in template:
        return template.replace("$Number%05d$", f"{number:05d}")
    if "$Number$" in template:
        return template.replace("$Number$", str(number))
    return None


def _select_reference_template(period: ET.Element, ns: dict[str, str]) -> Optional[ET.Element]:
    candidates = period.findall("mpd:AdaptationSet", ns)
    for adapt in candidates:
        template = adapt.find("mpd:Representation/mpd:SegmentTemplate", ns)
        if template is not None:
            return template
    return None


def _append_text_adaptation(
    *,
    period: ET.Element,
    ns_uri: str,
    template_source: ET.Element,
    language: str,
    start_number: int,
) -> None:
    label = language.upper()
    adaptation = ET.Element(
        f"{{{ns_uri}}}AdaptationSet",
        {
            "id": f"text-{language}",
            "contentType": "text",
            "lang": language,
            "label": label,
        },
    )
    representation = ET.SubElement(
        adaptation,
        f"{{{ns_uri}}}Representation",
        {
            "id": f"text-{language}-0",
            "bandwidth": "1",
            "mimeType": "text/vtt",
        },
    )

    template_attrs = dict(template_source.attrib)
    template_attrs.pop("initialization", None)
    template_attrs["media"] = f"text_{language}_$Number$.vtt"
    template_attrs["startNumber"] = str(start_number)
    segment_template = ET.SubElement(
        representation,
        f"{{{ns_uri}}}SegmentTemplate",
        template_attrs,
    )
    timeline = template_source.find(f"{{{ns_uri}}}SegmentTimeline")
    if timeline is not None:
        segment_template.append(copy.deepcopy(timeline))

    period.append(adaptation)
