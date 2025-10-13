"""Helpers for constructing and running Shaka Packager commands."""
from __future__ import annotations

import logging
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional, Sequence

LOGGER = logging.getLogger(__name__)


def _format_float(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


@dataclass(slots=True)
class PackagerStream:
    """Single input stream configuration for Shaka Packager."""

    input_path: Path
    stream: str
    init_segment: Optional[Path]
    segment_template: str
    language: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None
    extra_flags: Sequence[str] = field(default_factory=tuple)

    def argument(self) -> str:
        parts: list[str] = [
            f"in={self._normalize(self.input_path)}", f"stream={self.stream}"]
        if self.init_segment is not None:
            parts.append(f"init_segment={self._normalize(self.init_segment)}")
        parts.append(f"segment_template={self.segment_template}")
        if self.language:
            parts.append(f"language={self.language}")
        if self.name:
            parts.append(f"name={self.name}")
        if self.role:
            parts.append(f"roles={self.role}")
        parts.extend(self.extra_flags)
        return ",".join(parts)

    @staticmethod
    def _normalize(path: Path) -> str:
        return str(Path(path).expanduser().resolve())


@dataclass(slots=True)
class PackagerJob:
    """Representation of a Shaka Packager invocation."""

    binary: str
    mpd_output: Path
    streams: Sequence[PackagerStream]
    segment_duration: Optional[float] = None
    availability_time_offset: Optional[float] = None
    time_shift_buffer_depth: Optional[float] = None
    preserved_segments_outside_live_window: Optional[int] = None
    minimum_update_period: Optional[float] = None
    min_buffer_time: Optional[float] = None
    suggested_presentation_delay: Optional[float] = None
    allow_approximate_segment_timeline: bool = True
    extra_args: Sequence[str] = field(default_factory=tuple)

    def command(self) -> list[str]:
        cmd: list[str] = [self.binary]
        for stream in self.streams:
            cmd.append(stream.argument())
        cmd.append(f"--mpd_output={self._normalize(self.mpd_output)}")
        if self.segment_duration is not None and self.segment_duration > 0:
            cmd.append(
                f"--segment_duration={_format_float(self.segment_duration)}")
        if self.availability_time_offset is not None and self.availability_time_offset >= 0:
            cmd.append(
                f"--availability_time_offset={_format_float(self.availability_time_offset)}")
        if self.time_shift_buffer_depth is not None and self.time_shift_buffer_depth > 0:
            cmd.append(
                f"--time_shift_buffer_depth={_format_float(self.time_shift_buffer_depth)}"
            )
        if self.preserved_segments_outside_live_window is not None:
            cmd.append(
                f"--preserved_segments_outside_live_window={self.preserved_segments_outside_live_window}"
            )
        if self.minimum_update_period is not None and self.minimum_update_period >= 0:
            cmd.append(
                f"--minimum_update_period={_format_float(self.minimum_update_period)}"
            )
        if self.min_buffer_time is not None and self.min_buffer_time >= 0:
            cmd.append(
                f"--min_buffer_time={_format_float(self.min_buffer_time)}")
        if self.suggested_presentation_delay is not None and self.suggested_presentation_delay >= 0:
            cmd.append(
                f"--suggested_presentation_delay={_format_float(self.suggested_presentation_delay)}"
            )
        if not self.allow_approximate_segment_timeline:
            cmd.append("--allow_approximate_segment_timeline=false")
        cmd.extend(self.extra_args)
        return cmd

    def start(self, *, capture_output: bool = False) -> subprocess.Popen[str]:
        """Launch Shaka Packager and return the running process."""

        command = self.command()
        LOGGER.info("Starting packager: %s", shlex.join(command))
        stdout_opt = subprocess.PIPE if capture_output else None
        stderr_opt = subprocess.PIPE if capture_output else None
        return subprocess.Popen(command, text=True, stdout=stdout_opt, stderr=stderr_opt)

    @staticmethod
    def _normalize(path: Path) -> str:
        return str(Path(path).expanduser().resolve())
