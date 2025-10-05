"""Higher-level orchestration helpers for FFmpeg DASH encoding."""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from collections import defaultdict
from pathlib import Path
from typing import Iterable, List, Optional, Set

import subprocess

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
                    continue
            except OSError:
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

    def __init__(self, encoder: FFmpegDashEncoder, publisher: SegmentPublisher | None = None, poll_interval: float = 2.0) -> None:
        self.encoder = encoder
        self.publisher = publisher or NoOpPublisher()
        self.poll_interval = poll_interval
        dash_opts = self.encoder.settings.dash
        retain = dash_opts.retention_segments
        if retain is None:
            retain = max(dash_opts.window_size + dash_opts.extra_window_size, dash_opts.window_size)
        self._segment_pruner = SegmentPruner(
            self.encoder.settings.output_dir,
            retain_per_representation=max(1, retain),
            basename=self.encoder.settings.output_basename,
        )
        self._published_static_assets: Set[Path] = set()

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
        self.publisher.publish(mpd_path, segments)

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

        tracker = DashSegmentTracker(self.encoder.settings.output_dir)
        mpd_path = self.encoder.settings.mpd_path
        pending_static: set[Path] = set()
        if static_assets:
            for asset in static_assets:
                path = Path(asset).expanduser().resolve()
                if path.exists():
                    pending_static.add(path)

        def publisher_loop() -> None:
            manifest_sent = False
            while True:
                if mpd_path.exists():
                    try:
                        new_segments = tracker.new_segments(mpd_path)
                        publish_needed = new_segments or not manifest_sent
                        if publish_needed and not isinstance(self.publisher, NoOpPublisher):
                            LOGGER.info(
                                "Publishing %d new segment(s) (manifest sent=%s)",
                                len(new_segments),
                                manifest_sent,
                            )
                            self.publisher.publish(mpd_path, new_segments)
                            manifest_sent = True
                        elif publish_needed:
                            if not manifest_sent:
                                LOGGER.info("Manifest available locally; no remote publisher configured")
                            manifest_sent = True
                        if pending_static and not isinstance(self.publisher, NoOpPublisher):
                            ready = [asset for asset in list(pending_static) if asset.exists()]
                            if ready:
                                LOGGER.info(
                                    "Publishing %d static subtitle asset(s)",
                                    len(ready),
                                )
                                self.publisher.publish(mpd_path, ready)
                                self._mark_static_assets_published(ready)
                                pending_static.difference_update(ready)
                    except PublisherError:
                        LOGGER.exception("Failed to publish DASH segments")

                    removed, _kept = self._segment_pruner.prune()
                    if removed:
                        LOGGER.info("Pruned %d stale segment(s)", len(removed))
                        tracker.forget(removed)
                        try:
                            self.publisher.remove(removed)
                        except PublisherError:
                            LOGGER.exception("Failed to remove published DASH segments")
                if process.poll() is not None:
                    LOGGER.info("FFmpeg process exited with code %s", process.returncode)
                    # Final flush on shutdown
                    if mpd_path.exists():
                        try:
                            remaining = tracker.new_segments(mpd_path)
                            if remaining and not isinstance(self.publisher, NoOpPublisher):
                                LOGGER.info(
                                    "Publishing %d remaining segment(s) during shutdown",
                                    len(remaining),
                                )
                                self.publisher.publish(mpd_path, remaining)
                            if pending_static and not isinstance(self.publisher, NoOpPublisher):
                                ready = [asset for asset in list(pending_static) if asset.exists()]
                                if ready:
                                    LOGGER.info(
                                        "Publishing %d remaining static asset(s) during shutdown",
                                        len(ready),
                                    )
                                    self.publisher.publish(mpd_path, ready)
                                    self._mark_static_assets_published(ready)
                                    pending_static.difference_update(ready)
                            removed, _kept = self._segment_pruner.prune()
                            if removed:
                                LOGGER.info("Pruned %d stale segment(s) during shutdown", len(removed))
                                tracker.forget(removed)
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
    if chunk_prefix not in name:
        return None, None
    try:
        remainder = name.split('_chunk_', 1)[1]
        rep_part, number_part = remainder.rsplit('_', 1)
        number_str = number_part.split('.', 1)[0]
        return rep_part, int(number_str)
    except (ValueError, IndexError):  # pragma: no cover - defensive parsing
        return None, None
