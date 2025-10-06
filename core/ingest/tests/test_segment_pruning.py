from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve()
INGEST_ROOT = HERE.parents[1]
if str(INGEST_ROOT) not in sys.path:
    sys.path.insert(0, str(INGEST_ROOT))


def _put_segment(client, path: str, payload: bytes) -> int:
    response = client.put(
        path,
        data=payload,
        content_type="application/octet-stream",
    )
    return response.status_code


def _list_segments(directory: Path, pattern: str) -> list[str]:
    return sorted(path.name for path in directory.glob(pattern))


@pytest.fixture()
def ingest_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("TRANSCODER_OUTPUT", str(tmp_path))
    monkeypatch.setenv("INGEST_RETENTION_SEGMENTS", "3")
    ingest_config = importlib.import_module("src.config")
    importlib.reload(ingest_config)
    ingest_module = importlib.import_module("src")
    importlib.reload(ingest_module)
    config_map = ingest_config.build_default_config()
    assert Path(config_map["TRANSCODER_OUTPUT"]).resolve() == tmp_path.resolve()
    app = ingest_module.create_app()
    yield app


def test_prunes_per_representation(ingest_app):
    client = ingest_app.test_client()
    session_dir = Path(ingest_app.config["TRANSCODER_OUTPUT"]) / "sessions" / "demo"

    for index in range(5):
        status = _put_segment(
            client,
            f"/media/sessions/demo/chunk-0-{index + 1:05d}.m4s",
            b"video",
        )
        assert status in {200, 201}

    for index in range(4):
        status = _put_segment(
            client,
            f"/media/sessions/demo/chunk-1-{index + 1:05d}.m4s",
            b"audio",
        )
        assert status in {200, 201}

    # init segments should be left untouched
    assert _put_segment(
        client,
        "/media/sessions/demo/init-0.m4s",
        b"init",
    ) in {200, 201}

    assert session_dir.exists()
    assert _list_segments(session_dir, "chunk-0-*.m4s") == [
        "chunk-0-00003.m4s",
        "chunk-0-00004.m4s",
        "chunk-0-00005.m4s",
    ]
    assert _list_segments(session_dir, "chunk-1-*.m4s") == [
        "chunk-1-00002.m4s",
        "chunk-1-00003.m4s",
        "chunk-1-00004.m4s",
    ]
    assert (session_dir / "init-0.m4s").exists()
