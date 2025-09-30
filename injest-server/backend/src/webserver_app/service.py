"""Helpers for generating manifests served by the webserver."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET

from .storage import ContentStore

MPD_NS = "urn:mpeg:dash:schema:mpd:2011"
NS_MAP = {"mpd": MPD_NS}
ET.register_namespace("", MPD_NS)


@dataclass(frozen=True, slots=True)
class SubtitleTrack:
    key: str
    language: str


class ManifestService:
    """Generate manifests with on-the-fly subtitle adaptation sets."""

    def __init__(self, store: ContentStore, *, base_manifest: str = "audio_video.mpd", master_manifest: str = "master.mpd") -> None:
        self.store = store
        self.base_manifest = base_manifest
        self.master_manifest = master_manifest

    def render(self, key: str) -> bytes:
        if key == self.master_manifest:
            return self._render_master()

        path = self.store.resolve(key)
        if not path.exists():
            raise FileNotFoundError(path)
        return path.read_bytes()

    def manifest_path(self, key: str) -> Path:
        return self.store.resolve(key)

    def _render_master(self) -> bytes:
        base_path = self.store.resolve(self.base_manifest)
        if not base_path.exists():
            raise FileNotFoundError(base_path)

        root = ET.fromstring(base_path.read_bytes())
        period = root.find("mpd:Period", namespaces=NS_MAP)
        if period is None:
            raise ValueError("Base manifest is missing a Period element")

        # Drop any existing text adaptation sets to avoid duplication.
        for adaptation in list(period.findall("mpd:AdaptationSet", namespaces=NS_MAP)):
            if adaptation.get("contentType") == "text":
                period.remove(adaptation)

        subtitles = list(self._subtitle_tracks())
        if subtitles:
            adaptation = ET.SubElement(
                period,
                _tag("AdaptationSet"),
                {
                    "id": "text",
                    "contentType": "text",
                    "mimeType": "text/vtt",
                },
            )
            ET.SubElement(
                adaptation,
                _tag("Role"),
                {"schemeIdUri": "urn:mpeg:dash:role:2011", "value": "subtitle"},
            )

            for track in subtitles:
                rep = ET.SubElement(
                    adaptation,
                    _tag("Representation"),
                    {
                        "id": f"sub-{track.language}",
                        "bandwidth": "256",
                        "mimeType": "text/vtt",
                        "codecs": "wvtt",
                        "lang": track.language,
                    },
                )
                base_url = ET.SubElement(rep, _tag("BaseURL"))
                base_url.text = track.key

        _indent(root)
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)

    def _subtitle_tracks(self) -> Iterable[SubtitleTrack]:
        for path in sorted(self.store.root.rglob("*.vtt")):
            try:
                relative = path.relative_to(self.store.root)
            except ValueError:
                continue
            key = relative.as_posix()
            language = _infer_language(path.stem)
            yield SubtitleTrack(key=key, language=language)


def _tag(name: str) -> str:
    return f"{{{MPD_NS}}}{name}"


def _indent(elem: ET.Element, level: int = 0) -> None:
    indent = "\n" + "  " * level
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = indent + "  "
        for child in elem:
            _indent(child, level + 1)
            if not child.tail or not child.tail.strip():
                child.tail = indent + "  "
        if not elem[-1].tail or not elem[-1].tail.strip():
            elem[-1].tail = indent
    else:
        if level and (not elem.tail or not elem.tail.strip()):
            elem.tail = indent


def _infer_language(stem: str) -> str:
    candidate = stem
    for separator in (".", "_"):
        if separator in candidate:
            candidate = candidate.split(separator)[-1]
    return candidate.lower() or stem.lower()
