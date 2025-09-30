"""Local storage helper for the webserver application."""
from __future__ import annotations

from pathlib import Path
from typing import Iterable


class ContentStore:
    """Persist DASH manifests and segments on disk."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents and path != self.root:
            raise ValueError("Resource path escapes content root")
        return path

    def put(self, key: str, data: bytes) -> Path:
        path = self.resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def delete(self, key: str) -> bool:
        path = self.resolve(key)
        if not path.exists():
            return False
        path.unlink()
        return True

    def list(self) -> Iterable[Path]:
        yield from self.root.rglob('*')
