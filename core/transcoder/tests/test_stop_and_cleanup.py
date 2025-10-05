import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
API_SRC = REPO_ROOT / "core" / "api" / "src"
TRANSCODER_SRC = REPO_ROOT / "core" / "transcoder" / "src"

if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))
if str(TRANSCODER_SRC) not in sys.path:
    sys.path.insert(0, str(TRANSCODER_SRC))

from transcoder.pipeline import DashTranscodePipeline, LiveEncodingHandle, SegmentPublisher  # type: ignore  # noqa: E402
from services.controller import TranscoderController  # type: ignore  # noqa: E402


class DummyDashOptions:
    def __init__(self) -> None:
        self.retention_segments = None
        self.window_size = 4
        self.extra_window_size = 2


class DummySettings:
    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_basename = "stream"
        self.mpd_path = output_dir / "stream.mpd"
        self.dash = DummyDashOptions()


class DummyEncoder:
    def __init__(self, output_dir: Path) -> None:
        self.settings = DummySettings(output_dir)


class RecordingPublisher(SegmentPublisher):
    def __init__(self) -> None:
        self.removed_batches: list[list[Path]] = []

    def publish(self, mpd_path: Path, segment_paths):  # pragma: no cover - not used here
        return None

    def remove(self, segment_paths):
        batch = [Path(path) for path in segment_paths]
        self.removed_batches.append(batch)


class FakeThread:
    def __init__(self) -> None:
        self.join_called = False

    def is_alive(self) -> bool:
        return True

    def join(self, timeout: float | None = None) -> None:
        self.join_called = True


class FakePipeline:
    def __init__(self, output_dir: Path) -> None:
        self.encoder = type("Encoder", (), {"settings": type("Settings", (), {"output_dir": output_dir})})()
        self.cleaned = False

    def cleanup_output(self):
        self.cleaned = True
        return []


def test_controller_stop_terminates_process(tmp_path: Path) -> None:
    controller = TranscoderController()
    process = subprocess.Popen(["sleep", "60"])  # noqa: S603, S607 - testing signal handling
    handle = LiveEncodingHandle(process=process, publisher_thread=None)
    fake_thread = FakeThread()
    fake_pipeline = FakePipeline(tmp_path)

    with controller._lock:  # type: ignore[attr-defined]
        controller._handle = handle  # type: ignore[attr-defined]
        controller._thread = fake_thread  # type: ignore[attr-defined]
        controller._pipeline = fake_pipeline  # type: ignore[attr-defined]
        controller._state = "running"  # type: ignore[attr-defined]

    try:
        stopped = controller.stop()
    finally:
        if process.poll() is None:
            process.kill()

    assert stopped is True
    assert process.poll() is not None
    assert fake_thread.join_called is True
    assert fake_pipeline.cleaned is True


def test_cleanup_output_removes_static_assets(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    encoder = DummyEncoder(output_dir)
    publisher = RecordingPublisher()
    pipeline = DashTranscodePipeline(encoder, publisher=publisher)

    manifest = encoder.settings.mpd_path
    manifest.write_text("<MPD />", encoding="utf-8")
    segment = output_dir / "chunk-0-00001.m4s"
    segment.write_bytes(b"data")
    static_dir = output_dir / "subtitles" / "item"
    static_dir.mkdir(parents=True, exist_ok=True)
    subtitle = static_dir / "part_en.vtt"
    subtitle.write_text("WEBVTT", encoding="utf-8")

    pipeline._mark_static_assets_published([subtitle])  # type: ignore[attr-defined]

    removed = pipeline.cleanup_output()

    assert manifest.exists() is False
    assert segment.exists() is False
    assert subtitle.exists() is True

    assert manifest in removed
    assert segment in removed

    flattened = [path for batch in publisher.removed_batches for path in batch]
    assert manifest in flattened
    assert segment in flattened
    assert subtitle in flattened

    # ensure static paths no longer tracked after cleanup
    assert not pipeline._published_static_assets  # type: ignore[attr-defined]
