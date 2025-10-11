"""Data structures that describe the transcoder controller state."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Mapping, Optional


@dataclass
class TranscoderStatus:
    """Snapshot of the controller's current state."""

    state: str
    running: bool
    pid: Optional[int]
    packager_pid: Optional[int]
    output_dir: Optional[str]
    output_manifest: Optional[str]
    last_error: Optional[str]
    publish_base_url: Optional[str]
    manifest_url: Optional[str]
    subtitle_tracks: Optional[List[Mapping[str, Any]]]
    session_id: Optional[str] = None

    def to_session(
        self,
        *,
        log_file: Optional[str] = None,
        origin: Optional[str] = None,
        updated_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """Render a session dictionary for API responses."""

        subtitles: list[dict[str, Any]] = []
        if self.subtitle_tracks:
            for track in self.subtitle_tracks:
                if isinstance(track, Mapping):
                    subtitles.append(dict(track))

        session: dict[str, Any] = {
            "state": self.state,
            "running": self.running,
            "pid": self.pid,
            "packager_pid": self.packager_pid,
            "output_dir": self.output_dir,
            "output_manifest": self.output_manifest,
            "last_error": self.last_error,
            "publish_base_url": self.publish_base_url,
            "manifest_url": self.manifest_url,
            "subtitles": subtitles,
        }

        if self.session_id is not None:
            session["session_id"] = self.session_id

        if log_file is not None:
            session["log_file"] = log_file
        if origin:
            session["origin"] = origin
        if updated_at:
            session["updated_at"] = updated_at
        return session


__all__ = ["TranscoderStatus"]
