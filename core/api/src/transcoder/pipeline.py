"""Higher-level orchestration helpers for FFmpeg DASH encoding."""
from __future__ import annotations

import logging
import shutil
import threading
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from collections import defaultdict
from pathlib import Path
from typing import Iterable, List, Optional, Set, Any, Dict

import copy

import subprocess
import xml.etree.ElementTree as ET

from .encoder import FFmpegDashEncoder
from .exceptions import PublisherError
from .publishing import NoOpPublisher, SegmentPublisher

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class DashSegmentTracker:
    """Track previously-published segments and compute incremental updates."""

    output_dir: Path
    _seen: Set[Path] = field(default_factory=set, init=False)

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def all_segments(self, mpd_path: Path) -> List[Path]:
        return _collect_segment_files(self.output_dir, mpd_path)

    def new_segments(self, mpd_path: Path) -> List[Path]:
        segments = self.all_segments(mpd_path)
        fresh: List[Path] = []
        for segment in segments:
            if segment in self._seen:
                continue
            try:
                if segment.stat().st_size == 0:
                    # Skip zero-byte artifacts until FFmpeg finishes writing them.
                    LOGGER.debug("Segment %s is zero bytes; deferring publish", segment)
                    continue
            except OSError:
                LOGGER.debug("Unable to stat segment %s; will retry", segment)
                continue
            fresh.append(segment)
        self._seen.update(fresh)
        return fresh

    def forget(self, paths: Iterable[Path]) -> None:
        resolved = {Path(path).expanduser().resolve() for path in paths}
        self._seen.difference_update(resolved)


@dataclass(slots=True)
class LiveEncodingHandle:
    """Wrap the running FFmpeg process and optional publisher thread."""

    process: 'subprocess.Popen[str]'
    publisher_thread: Optional[threading.Thread] = None

    def wait(self) -> int:
        """Block until the FFmpeg process exits."""

        return self.process.wait()




@dataclass(slots=True)
class SegmentPruner:
    """Delete stale DASH segments so the output directory mirrors the live window."""

    output_dir: Path
    retain_per_representation: int
    basename: str

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.retain_per_representation = max(1, int(self.retain_per_representation))

    def prune(self) -> tuple[list[Path], set[Path]]:
        removed: list[Path] = []
        kept: set[Path] = set()
        if not self.output_dir.exists():
            return removed, kept

        segments = defaultdict(list)
        for path in self.output_dir.rglob('*.m4s'):
            rep_id, number = _parse_segment_metadata(path, self.basename)
            if rep_id is None or number is None:
                continue
            segments[rep_id].append((number, path))

        for items in segments.values():
            items.sort(key=lambda pair: pair[0])
            keep_items = items[-self.retain_per_representation :]
            kept.update(path for _, path in keep_items)
            for _, path in items[:-self.retain_per_representation]:
                try:
                    path.unlink()
                    removed.append(path)
                except OSError:
                    LOGGER.warning("Failed to delete stale segment: %s", path)

        return removed, kept

class DashTranscodePipeline:
    """Combine the encoder with optional publishing strategies."""

    def __init__(
        self,
        encoder: FFmpegDashEncoder,
        publisher: SegmentPublisher | None = None,
        poll_interval: float = 0.5,
        session_prefix: Optional[str] = None,
    ) -> None:
        self.encoder = encoder
        self.publisher = publisher or NoOpPublisher()
        self.poll_interval = poll_interval
        if session_prefix is None:
            session_prefix = encoder.settings.session_segment_prefix
        self._session_prefix = session_prefix.strip("/") if session_prefix else None
        self._output_dir = self.encoder.settings.output_dir.expanduser().resolve()
        if self._session_prefix:
            session_dir = (self.encoder.settings.output_dir / self._session_prefix).expanduser().resolve()
        else:
            session_dir = self.encoder.settings.output_dir
        self._session_dir = session_dir
        self._session_dir.mkdir(parents=True, exist_ok=True)
        dash_opts = self.encoder.settings.dash
        retain = dash_opts.retention_segments
        if retain is None:
            window_size = dash_opts.window_size if dash_opts.window_size is not None else 24
            extra_window = dash_opts.extra_window_size if dash_opts.extra_window_size is not None else 0
            retain = max(window_size + extra_window, window_size)
        self._segment_pruner = SegmentPruner(
            self._session_dir,
            retain_per_representation=max(1, retain),
            basename=self.encoder.settings.output_basename,
        )
        self._published_static_assets: Set[Path] = set()
        self._session_order: list[str] = []
        self._session_segments: dict[str, dict[str, dict[str, int]]] = {}

    def run_vod(self, publish: bool = True) -> 'subprocess.CompletedProcess[str]':
        """Execute FFmpeg to completion and optionally publish all segments afterwards."""

        result = self.encoder.run_to_completion(check=True)
        if publish:
            self.publish_all()
        return result

    def publish_all(self) -> None:
        """Publish every segment currently present in the output directory."""

        mpd_path = self.encoder.settings.mpd_path
        if not mpd_path.exists():
            raise PublisherError(f"Manifest not found at {mpd_path}")
        segments = _collect_segment_files(self.encoder.settings.output_dir, mpd_path)
        LOGGER.info("Publishing %d segments via %s", len(segments), self.publisher.__class__.__name__)
        snapshot = self._snapshot_manifest(mpd_path)
        self.publisher.publish(mpd_path, segments, mpd_snapshot=snapshot)

    def cleanup_output(self) -> list[Path]:
        """Remove DASH artifacts from the output directory and notify the publisher."""

        removed: list[Path] = []
        output_dir = self.encoder.settings.output_dir
        if not output_dir.exists():
            return removed

        patterns = ("*.mpd", "*.m4s", "*.m4a", "*.m4v", "*.mp4", "*.tmp")
        for pattern in patterns:
            for path in output_dir.glob(pattern):
                if not path.is_file():
                    continue
                try:
                    path.unlink()
                    removed.append(path)
                except OSError:
                    LOGGER.warning("Failed to delete DASH artifact: %s", path)

        if removed:
            try:
                self.publisher.remove(removed)
            except PublisherError:
                LOGGER.exception("Failed to remove published DASH artifacts")

        static_assets = list(self._published_static_assets)
        if static_assets:
            try:
                self.publisher.remove(static_assets)
            except PublisherError:
                LOGGER.exception("Failed to remove published static assets")
            else:
                LOGGER.info("Requested removal of %d static asset(s)", len(static_assets))
            finally:
                self._published_static_assets.clear()

        return removed

    def start_live(
        self,
        poll_interval: Optional[float] = None,
        static_assets: Optional[Iterable[Path]] = None,
    ) -> LiveEncodingHandle:
        """Start FFmpeg for live streaming and publish segments as they appear."""

        interval = poll_interval or self.poll_interval
        process = self.encoder.start()

        tracker = DashSegmentTracker(self._session_dir)
        mpd_path = self.encoder.settings.mpd_path
        pending_static: set[Path] = set()
        if static_assets:
            for asset in static_assets:
                path = Path(asset).expanduser().resolve()
                if path.exists():
                    pending_static.add(path)

        def publisher_loop() -> None:
            manifest_sent = False
            manifest_logged = False
            while True:
                if mpd_path.exists():
                    if not manifest_logged:
                        try:
                            mpd_stat = mpd_path.stat()
                            mpd_age_ms = max(0.0, (time.time() - mpd_stat.st_mtime) * 1000)
                            LOGGER.info(
                                "Detected manifest %s size=%d age_ms=%.2f",
                                mpd_path.name,
                                mpd_stat.st_size,
                                mpd_age_ms,
                            )
                        except OSError:
                            LOGGER.warning("Manifest %s discovered but stat() failed", mpd_path)
                        manifest_logged = True
                    try:
                        new_segments = self._filter_session_segments(tracker.new_segments(mpd_path))
                        if new_segments:
                            LOGGER.info(
                                "Discovered %d new segment(s): %s",
                                len(new_segments),
                                "; ".join(
                                    _format_segment_details(
                                        path,
                                        self.encoder.settings.output_basename,
                                    )
                                    for path in new_segments
                                ),
                            )
                            self._record_segments(new_segments)
                        publish_needed = bool(new_segments)
                        if not manifest_sent and not publish_needed:
                            LOGGER.debug(
                                "Manifest %s available but no publishable segments yet; deferring",
                                mpd_path.name,
                            )
                        if publish_needed and not isinstance(self.publisher, NoOpPublisher):
                            LOGGER.info(
                                "Publishing %d new segment(s) (manifest sent=%s)",
                                len(new_segments),
                                manifest_sent,
                            )
                            self._write_multi_period_manifest(mpd_path)
                            snapshot_path = self._snapshot_manifest(mpd_path)
                            LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                            self.publisher.publish(
                                mpd_path,
                                new_segments,
                                mpd_snapshot=snapshot_path,
                            )
                            manifest_sent = True
                        elif publish_needed:
                            if not manifest_sent:
                                LOGGER.info("Manifest available locally; no remote publisher configured")
                            manifest_sent = True
                        if pending_static and not isinstance(self.publisher, NoOpPublisher):
                            ready = [
                                asset for asset in list(pending_static)
                                if asset.exists() and self._is_session_path(asset)
                            ]
                            if ready:
                                LOGGER.info(
                                    "Publishing %d static subtitle asset(s)",
                                    len(ready),
                                )
                                self._write_multi_period_manifest(mpd_path)
                                snapshot_path = self._snapshot_manifest(mpd_path)
                                LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                                self.publisher.publish(
                                    mpd_path,
                                    ready,
                                    mpd_snapshot=snapshot_path,
                                )
                                self._mark_static_assets_published(ready)
                                pending_static.difference_update(ready)
                    except PublisherError:
                        LOGGER.exception("Failed to publish DASH segments")

                    removed, _kept = self._segment_pruner.prune()
                    if removed:
                        LOGGER.info(
                            "Pruned %d stale segment(s): %s",
                            len(removed),
                            ", ".join(path.name for path in removed),
                        )
                        tracker.forget(removed)
                        self._forget_segments(removed)
                        try:
                            self.publisher.remove(removed)
                        except PublisherError:
                            LOGGER.exception("Failed to remove published DASH segments")
                        if mpd_path.exists() and not isinstance(self.publisher, NoOpPublisher):
                            try:
                                # Regenerate the manifest so startNumber/SegmentTimeline reflect surviving segments.
                                self._write_multi_period_manifest(mpd_path)
                                snapshot_path = self._snapshot_manifest(mpd_path)
                                LOGGER.info("Captured manifest snapshot %s after pruning", snapshot_path)
                                self.publisher.publish(
                                    mpd_path,
                                    [],
                                    mpd_snapshot=snapshot_path,
                                )
                                manifest_sent = True
                            except PublisherError:
                                LOGGER.exception("Failed to refresh manifest after pruning")
                if process.poll() is not None:
                    LOGGER.info("FFmpeg process exited with code %s", process.returncode)
                    # Final flush on shutdown
                    if mpd_path.exists():
                        try:
                            remaining = self._filter_session_segments(tracker.new_segments(mpd_path))
                            if remaining and not isinstance(self.publisher, NoOpPublisher):
                                LOGGER.info(
                                    "Publishing %d remaining segment(s) during shutdown",
                                    len(remaining),
                                )
                                self._record_segments(remaining)
                                self._write_multi_period_manifest(mpd_path)
                                snapshot_path = self._snapshot_manifest(mpd_path)
                                LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                                self.publisher.publish(
                                    mpd_path,
                                    remaining,
                                    mpd_snapshot=snapshot_path,
                                )
                            if pending_static and not isinstance(self.publisher, NoOpPublisher):
                                ready = [
                                    asset for asset in list(pending_static)
                                    if asset.exists() and self._is_session_path(asset)
                                ]
                                if ready:
                                    LOGGER.info(
                                        "Publishing %d remaining static asset(s) during shutdown",
                                        len(ready),
                                    )
                                    self._write_multi_period_manifest(mpd_path)
                                    snapshot_path = self._snapshot_manifest(mpd_path)
                                    LOGGER.info("Captured manifest snapshot %s", snapshot_path)
                                    self.publisher.publish(
                                        mpd_path,
                                        ready,
                                        mpd_snapshot=snapshot_path,
                                    )
                                    self._mark_static_assets_published(ready)
                                    pending_static.difference_update(ready)
                            removed, _kept = self._segment_pruner.prune()
                            if removed:
                                LOGGER.info("Pruned %d stale segment(s) during shutdown", len(removed))
                                tracker.forget(removed)
                                self._forget_segments(removed)
                                try:
                                    self.publisher.remove(removed)
                                except PublisherError:
                                    LOGGER.exception("Failed to remove published DASH segments")
                        except PublisherError:
                            LOGGER.exception("Failed to publish remaining DASH segments")
                    break
                time.sleep(interval)

        thread = threading.Thread(target=publisher_loop, name="dash-publisher", daemon=True)
        thread.start()
        LOGGER.info("Started live FFmpeg process with %s publisher", self.publisher.__class__.__name__)
        return LiveEncodingHandle(process, thread)

    def _mark_static_assets_published(self, assets: Iterable[Path]) -> None:
        for asset in assets:
            try:
                resolved = Path(asset).expanduser().resolve()
            except Exception:
                continue
            self._published_static_assets.add(resolved)

    def _is_session_path(self, path: Path) -> bool:
        try:
            resolved = Path(path).expanduser().resolve()
        except Exception:
            return False
        try:
            relative = resolved.relative_to(self._output_dir)
        except ValueError:
            return False

        if not self._session_prefix:
            return True

        prefix_parts = Path(self._session_prefix).parts
        if len(relative.parts) < len(prefix_parts):
            return False
        if tuple(relative.parts[: len(prefix_parts)]) != prefix_parts:
            return False
        return True

    def _filter_session_segments(self, segments: Iterable[Path]) -> list[Path]:
        filtered: list[Path] = []
        for segment in segments:
            try:
                resolved = Path(segment).expanduser().resolve()
            except Exception:
                continue

            if resolved.name == f"{self.encoder.settings.output_basename}.mpd":
                filtered.append(resolved)
                continue

            if self._is_session_path(resolved):
                filtered.append(segment)
            else:
                LOGGER.debug("Skipping retained session segment: %s", segment)
        return filtered

    def _snapshot_manifest(self, mpd_path: Path) -> Path:
        resolved_mpd = Path(mpd_path).expanduser().resolve()
        if not resolved_mpd.exists():
            raise PublisherError(f"Cannot snapshot missing manifest at {resolved_mpd}")
        self._apply_manifest_overrides(resolved_mpd)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        history_dir = resolved_mpd.parent / "mpd-history"
        history_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = history_dir / f"{resolved_mpd.stem}-{timestamp}{resolved_mpd.suffix}"
        shutil.copy2(resolved_mpd, snapshot_path)
        self._apply_manifest_overrides(snapshot_path)
        return snapshot_path

    def _session_segment_numbers_from_disk(self, session_id: str) -> Dict[str, list[int]]:
        segments: Dict[str, list[int]] = defaultdict(list)
        base_output = Path(self.encoder.settings.output_dir).expanduser().resolve()
        candidates = [
            base_output / "sessions" / session_id,
            self._session_dir / session_id,
        ]
        seen_paths: set[Path] = set()
        for candidate in candidates:
            try:
                resolved = candidate.expanduser().resolve()
            except Exception:
                continue
            if not resolved.exists() or resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            for path in resolved.glob("chunk-*.m4s"):
                rep_id, number = _parse_segment_metadata(path, self.encoder.settings.output_basename)
                if rep_id is None or number is None:
                    continue
                segments.setdefault(rep_id, []).append(number)
        for numbers in segments.values():
            numbers.sort()
        return segments

    def _record_segments(self, segments: Iterable[Path]) -> None:
        for segment in segments:
            try:
                resolved = Path(segment).expanduser().resolve()
            except Exception:
                continue
            session_id = self._session_id_for_path(resolved)
            if not session_id:
                continue
            rep_id, number = _parse_segment_metadata(resolved, self.encoder.settings.output_basename)
            if rep_id is None or number is None:
                continue
            rep_bucket = self._session_segments.setdefault(session_id, {})
            entry = rep_bucket.setdefault(rep_id, {
                'first': number,
                'last': number,
                'count': 0,
            })
            entry['count'] += 1
            if number < entry['first']:
                entry['first'] = number
            if number > entry['last']:
                entry['last'] = number
            LOGGER.debug(
                "Recorded segment session=%s rep=%s number=%s count=%s",
                session_id,
                rep_id,
                number,
                entry['count'],
            )
            if session_id not in self._session_order:
                self._session_order.append(session_id)

    def _forget_segments(self, segments: Iterable[Path]) -> None:
        for segment in segments:
            try:
                resolved = Path(segment).expanduser().resolve()
            except Exception:
                continue
            session_id = self._session_id_for_path(resolved)
            if not session_id:
                continue
            rep_id, number = _parse_segment_metadata(resolved, self.encoder.settings.output_basename)
            if rep_id is None or number is None:
                continue
            rep_bucket = self._session_segments.get(session_id)
            if not rep_bucket:
                continue
            entry = rep_bucket.get(rep_id)
            if not entry:
                continue
            if entry['count'] > 0:
                entry['count'] -= 1
            if entry['count'] <= 0:
                LOGGER.debug(
                    "Removing empty rep bucket session=%s rep=%s",
                    session_id,
                    rep_id,
                )
                rep_bucket.pop(rep_id, None)
            else:
                if number == entry.get('first'):
                    entry['first'] = number + 1
                if number == entry.get('last') and entry['last'] > entry['first']:
                    entry['last'] = number - 1
                LOGGER.debug(
                    "Trimmed rep bucket session=%s rep=%s first=%s last=%s count=%s",
                    session_id,
                    rep_id,
                    entry.get('first'),
                    entry.get('last'),
                    entry.get('count'),
                )
            if not rep_bucket:
                LOGGER.debug("Removing empty session bucket %s", session_id)
                self._session_segments.pop(session_id, None)

    def _session_id_for_path(self, path: Path) -> Optional[str]:
        try:
            parts = path.relative_to(self.encoder.settings.output_dir).parts
        except ValueError:
            parts = path.parts
        for idx, part in enumerate(parts):
            if part == 'sessions' and idx + 1 < len(parts):
                return parts[idx + 1]
        if self._session_prefix:
            return self._session_prefix.rsplit('/', 1)[-1]
        return None

    def _write_multi_period_manifest(self, mpd_path: Path) -> None:
        try:
            tree = ET.parse(mpd_path)
        except ET.ParseError:
            LOGGER.debug("Unable to parse manifest %s; skipping multi-period rewrite", mpd_path)
            return

        root = tree.getroot()
        namespace = self._extract_namespace(root.tag)
        if not namespace:
            LOGGER.debug("Unable to determine namespace for manifest %s; skipping", mpd_path)
            return
        ns = {'mpd': namespace}

        period_node = root.find('mpd:Period', ns)
        if period_node is None:
            LOGGER.debug("Manifest %s missing Period node; skipping multi-period rewrite", mpd_path)
            return

        LOGGER.debug(
            "Building multi-period MPD from base manifest %s (sessions recorded=%s)",
            mpd_path,
            list(self._session_order),
        )

        adaptation_blueprints: list[dict[str, Any]] = []
        for adaptation in period_node.findall('mpd:AdaptationSet', ns):
            adapt_entry: dict[str, Any] = {
                'attrs': dict(adaptation.attrib),
                'children': [copy.deepcopy(child) for child in adaptation if child.tag != f'{{{namespace}}}Representation'],
                'representations': [],
            }
            for representation in adaptation.findall('mpd:Representation', ns):
                rep_entry: dict[str, Any] = {
                    'attrs': dict(representation.attrib),
                    'children': [copy.deepcopy(child) for child in representation if child.tag != f'{{{namespace}}}SegmentTemplate'],
                    'timescale': 1,
                    'initialization': None,
                    'media': None,
                    'segment_duration': None,
                }
                template = representation.find('mpd:SegmentTemplate', ns)
                if template is not None:
                    rep_entry['timescale'] = int(template.attrib.get('timescale', '1'))
                    rep_entry['initialization'] = template.attrib.get('initialization')
                    rep_entry['media'] = template.attrib.get('media')
                    timeline = template.find('mpd:SegmentTimeline', ns)
                    first_segment = None
                    if timeline is not None:
                        first_segment = timeline.find('mpd:S', ns)
                    if first_segment is not None and 'd' in first_segment.attrib:
                        rep_entry['segment_duration'] = int(first_segment.attrib['d'])
                    else:
                        rep_entry['segment_duration'] = int(template.attrib.get('duration', '0')) or rep_entry['timescale']
                adapt_entry['representations'].append(rep_entry)
            adaptation_blueprints.append(adapt_entry)
        LOGGER.debug(
            "Manifest blueprint representations: %s",
            [
                {
                    'adaptation': entry['attrs'].get('id'),
                    'reps': [
                        {
                            'id': rep['attrs'].get('id'),
                            'timescale': rep['timescale'],
                            'duration': rep['segment_duration'],
                        }
                        for rep in entry['representations']
                    ],
                }
                for entry in adaptation_blueprints
            ],
        )

        # Remove original periods before writing our own.
        for child in list(root):
            if child.tag == f'{{{namespace}}}Period':
                root.remove(child)

        max_sessions = 3
        sessions_to_emit = self._session_order[-max_sessions:]
        for session_id in sessions_to_emit:
            rep_map = self._session_segments.get(session_id, {})
            if not rep_map:
                continue
            disk_numbers = self._session_segment_numbers_from_disk(session_id)
            period = ET.SubElement(root, f'{{{namespace}}}Period', attrib={'id': session_id, 'start': 'PT0S'})
            period_start_seconds: Optional[float] = None
            LOGGER.debug(
                "Writing MPD period for session %s with reps=%s",
                session_id,
                {rep: state.get('count', 0) for rep, state in rep_map.items()},
            )
            for adapt_entry in adaptation_blueprints:
                adaptation = ET.SubElement(period, f'{{{namespace}}}AdaptationSet', attrib=adapt_entry['attrs'])
                for child in adapt_entry['children']:
                    adaptation.append(copy.deepcopy(child))
                for rep_entry in adapt_entry['representations']:
                    rep_id = rep_entry['attrs'].get('id')
                    segment_state = rep_map.get(rep_id)
                    numbers = disk_numbers.get(rep_id)
                    if not numbers:
                        continue
                    retain_limit = max(1, self._segment_pruner.retain_per_representation)
                    if len(numbers) > retain_limit:
                        numbers = numbers[-retain_limit:]
                    start_number = numbers[0]
                    last_number = numbers[-1]
                    segment_count = len(numbers)
                    if segment_state is not None:
                        segment_state['first'] = start_number
                        segment_state['last'] = last_number
                        segment_state['count'] = segment_count
                    if segment_count <= 0:
                        continue
                    representation = ET.SubElement(adaptation, f'{{{namespace}}}Representation', attrib=rep_entry['attrs'])
                    for child in rep_entry['children']:
                        representation.append(copy.deepcopy(child))
                    template_attrs = {
                        'timescale': str(rep_entry['timescale']),
                        'initialization': self._rewrite_template_path(rep_entry['initialization'], session_id),
                        'media': self._rewrite_template_path(rep_entry['media'], session_id),
                        'startNumber': str(start_number),
                    }
                    template = ET.SubElement(representation, f'{{{namespace}}}SegmentTemplate', attrib=template_attrs)
                    timeline = ET.SubElement(template, f'{{{namespace}}}SegmentTimeline')
                    duration_units = rep_entry['segment_duration'] or rep_entry['timescale']
                    base_time_units = max(0, (start_number - 1) * duration_units)
                    timescale = max(1, rep_entry['timescale'])
                    start_seconds = base_time_units / timescale
                    if period_start_seconds is None or start_seconds < period_start_seconds:
                        period_start_seconds = start_seconds
                    LOGGER.info(
                        "Manifest window session=%s rep=%s start=%s last=%s count=%s duration_units=%s base_time=%s timescale=%s",
                        session_id,
                        rep_id,
                        start_number,
                        last_number,
                        segment_count,
                        duration_units,
                        base_time_units,
                        timescale,
                    )
                    for number in numbers:
                        attrib = {'d': str(duration_units), 'n': str(number)}
                        if number == start_number:
                            attrib['t'] = str(base_time_units)
                        ET.SubElement(timeline, f'{{{namespace}}}S', attrib=attrib)

            if period_start_seconds is not None and period_start_seconds > 0.0:
                period.set('start', self._format_period_start(period_start_seconds))

        tree.write(mpd_path, encoding='utf-8', xml_declaration=True)

        # Trim stored sessions to the window we emitted
        if len(self._session_order) > max_sessions:
            obsolete = self._session_order[:-max_sessions]
            for session_id in obsolete:
                self._session_segments.pop(session_id, None)
            self._session_order = sessions_to_emit

        self._apply_manifest_overrides(mpd_path)

    @staticmethod
    def _extract_namespace(tag: str) -> Optional[str]:
        if tag.startswith('{') and '}' in tag:
            return tag[1: tag.index('}')]
        return None

    @staticmethod
    def _rewrite_template_path(template: Optional[str], session_id: str) -> Optional[str]:
        if not template or 'sessions/' not in template:
            return template
        prefix, remainder = template.split('sessions/', 1)
        if '/' not in remainder:
            return template
        _old, tail = remainder.split('/', 1)
        return f"{prefix}sessions/{session_id}/{tail}"

    @staticmethod
    def _format_period_start(seconds: float) -> str:
        if seconds <= 0.0:
            return "PT0S"
        if seconds.is_integer():
            return f"PT{int(seconds)}S"
        return f"PT{seconds:.6f}S".rstrip('0').rstrip('.')

    def _apply_manifest_overrides(self, manifest_path: Path) -> None:
        """Inject downstream-friendly attributes that FFmpeg may omit."""

        dash_opts = self.encoder.settings.dash
        desired_offset_value: Optional[float] = None
        if dash_opts and dash_opts.availability_time_offset is not None:
            try:
                desired_offset_value = max(0.0, float(dash_opts.availability_time_offset))
            except (TypeError, ValueError):
                desired_offset_value = None

        def _format_seconds(value: float) -> str:
            formatted = f"{value:.6f}".rstrip("0").rstrip(".")
            return formatted or "0"

        def _format_duration(value: float) -> str:
            seconds = max(0.0, value)
            base = f"{seconds:.6f}".rstrip("0").rstrip(".")
            return f"PT{base or '0'}S"

        try:
            tree = ET.parse(manifest_path)
        except ET.ParseError as exc:
            LOGGER.debug("Skipping manifest overrides for %s; parse failed: %s", manifest_path, exc)
            return

        root = tree.getroot()
        namespace = self._extract_namespace(root.tag)
        ns = {'mpd': namespace} if namespace else None
        changed = False
        attr_name = "availabilityTimeOffset"
        desired_offset: Optional[str] = None
        if desired_offset_value is not None and desired_offset_value > 0:
            desired_offset = _format_seconds(desired_offset_value)

        current = root.attrib.get(attr_name)
        if desired_offset is None:
            if current is not None:
                root.attrib.pop(attr_name, None)
                changed = True
        else:
            if current != desired_offset:
                root.set(attr_name, desired_offset)
                changed = True

        # Update suggestedPresentationDelay/minBufferTime to maintain a safe cushion.
        segment_duration = None
        if dash_opts:
            for candidate in (
                dash_opts.segment_duration,
                dash_opts.fragment_duration,
            ):
                try:
                    if candidate is not None:
                        value = float(candidate)
                        if value > 0:
                            segment_duration = value
                            break
                except (TypeError, ValueError):
                    continue
        if segment_duration is None:
            segment_duration = 2.0

        if desired_offset_value is None or desired_offset_value <= 0:
            availability_for_delay = segment_duration * 2.0
        else:
            availability_for_delay = desired_offset_value

        suggested_delay_value = max(
            segment_duration * 3.0,
            availability_for_delay + segment_duration,
        )
        buffer_time_value = max(segment_duration * 3.0, suggested_delay_value)

        suggested_attr = _format_duration(suggested_delay_value)
        if root.attrib.get("suggestedPresentationDelay") != suggested_attr:
            root.set("suggestedPresentationDelay", suggested_attr)
            changed = True

        current_buffer = root.attrib.get("minBufferTime")
        desired_buffer = _format_duration(buffer_time_value)
        if current_buffer != desired_buffer:
            root.set("minBufferTime", desired_buffer)
            changed = True

        def _apply_to_element(element: ET.Element) -> bool:
            existing = element.attrib.get(attr_name)
            if desired_offset is None:
                if existing is not None:
                    element.attrib.pop(attr_name, None)
                    return True
                return False
            if existing != desired_offset:
                element.set(attr_name, desired_offset)
                return True
            return False

        if ns is not None:
            templates = root.findall(".//mpd:SegmentTemplate", ns)
        else:
            templates = list(root.iterfind(".//SegmentTemplate"))
        for tmpl in templates:
            if _apply_to_element(tmpl):
                changed = True

        if changed:
            if desired_offset is not None:
                LOGGER.debug(
                    "Applied availabilityTimeOffset=%s to manifest %s",
                    desired_offset,
                    manifest_path.name,
                )
            else:
                LOGGER.debug(
                    "Removed availabilityTimeOffset from manifest %s",
                    manifest_path.name,
                )
            tree.write(manifest_path, encoding="utf-8", xml_declaration=True)


def _collect_segment_files(output_dir: Path, mpd_path: Path) -> List[Path]:
    files: List[Path] = []
    output_dir = Path(output_dir).expanduser().resolve()
    if not output_dir.exists():
        return files
    mpd_path = mpd_path.expanduser().resolve()
    for path in sorted(output_dir.rglob('*')):
        if path.is_dir():
            continue
        resolved = path.expanduser().resolve()
        if resolved == mpd_path:
            continue
        if resolved.suffix == '.tmp':
            continue
        files.append(resolved)
    return files


def _parse_segment_metadata(path: Path, basename: str) -> tuple[Optional[str], Optional[int]]:
    name = path.name
    chunk_prefix = f"{basename}_chunk_"
    if chunk_prefix in name:
        try:
            remainder = name.split('_chunk_', 1)[1]
            rep_part, number_part = remainder.rsplit('_', 1)
            number_str = number_part.split('.', 1)[0]
            return rep_part, int(number_str)
        except (ValueError, IndexError):  # pragma: no cover - defensive parsing
            return None, None
    if name.startswith('chunk-'):
        remainder = name[6:]
        rep_part, _, tail = remainder.partition('-')
        if not rep_part or not tail:
            return None, None
        number_str, _, _ = tail.partition('.')
        if not number_str:
            return None, None
        try:
            return rep_part, int(number_str)
        except ValueError:  # pragma: no cover - defensive parsing
            return None, None
    return None, None


def _format_segment_details(path: Path, basename: str) -> str:
    try:
        stat = path.stat()
    except OSError:
        return f"{path.name} (stat-failed)"

    rep_id, number = _parse_segment_metadata(path, basename)
    rep_display = rep_id if rep_id is not None else "?"
    seq_display = str(number) if number is not None else "?"
    age_ms = max(0.0, (time.time() - stat.st_mtime) * 1000)
    mtime_iso = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
    return (
        f"{path.name} rep={rep_display} seq={seq_display} "
        f"size={stat.st_size} age_ms={age_ms:.2f} mtime={mtime_iso}"
    )
