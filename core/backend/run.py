"""Sample usage of the dash-transcoder package for live development."""
from __future__ import annotations

import logging
import os
import signal
import sys
from pathlib import Path

from app.logging import configure_logging

REPO_ROOT = Path(__file__).resolve().parent
SRC_PATH = REPO_ROOT / "src"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(SRC_PATH) not in sys.path:
    sys.path.insert(0, str(SRC_PATH))

LOG_FILE = configure_logging("run")
LOGGER = logging.getLogger(__name__)
LOGGER.info("Logging to %s", LOG_FILE)

try:
    import debugpy  # type: ignore

    DEBUGPY_PORT = int(os.getenv("DEBUGPY_PORT", "5678"))
    debugpy.listen(("0.0.0.0", DEBUGPY_PORT))
    if os.getenv("DEBUGPY_WAIT", "0") == "1":
        LOGGER.info("Waiting for debugger to attach on port %s", DEBUGPY_PORT)
        debugpy.wait_for_client()
    else:
        LOGGER.info("debugpy listening on port %s", DEBUGPY_PORT)
except ImportError:  # pragma: no cover - optional dependency
    LOGGER.debug("debugpy not available; skipping remote debugger setup")

from transcoder import (  # noqa: E402
    AudioEncodingOptions,
    DashMuxingOptions,
    DashTranscodePipeline,
    EncoderSettings,
    FFmpegDashEncoder,
    HttpPutPublisher,
    LiveEncodingHandle,
    LocalPublisher,
    VideoEncodingOptions,
)

# Paths for the sample run – adjust as needed for your environment.
INPUT_PATH = Path("/media/tmp/freakierfriday.mkv")
OUTPUT_DIR = REPO_ROOT.parent / "out"

# Encoding constraints for this sample.
VIDEO_OPTS = VideoEncodingOptions()
AUDIO_OPTS = AudioEncodingOptions()
DASH_OPTS = DashMuxingOptions()

# Optional publishing helpers. Toggle the flags in ``main`` to exercise these paths.
LOCAL_PUBLISH_TARGET = REPO_ROOT / "published"
# Replace with a real endpoint when testing HTTP PUT.
HTTP_BASE_URL = "https://example.com/dash/"


def build_encoder() -> FFmpegDashEncoder:
    settings = EncoderSettings(
        input_path=INPUT_PATH,
        output_dir=OUTPUT_DIR,
        output_basename="audio_video",
        video=VIDEO_OPTS,
        audio=AUDIO_OPTS,
        dash=DASH_OPTS,
        realtime_input=True,
    )
    return FFmpegDashEncoder(settings)


def preview_encoder(encoder: FFmpegDashEncoder) -> None:
    LOGGER.info("Discovered tracks:")
    for track in encoder.tracks:
        details = [track.media_type.value, f"rel={track.relative_index}"]
        if track.codec_name:
            details.append(f"codec={track.codec_name}")
        if track.language:
            details.append(f"lang={track.language}")
        if not encoder.is_track_supported(track):
            details.append("unsupported")
        LOGGER.info("  - %s", ", ".join(details))

    LOGGER.info("\nFFmpeg command (live configuration):\n%s\n",
                encoder.dry_run())


def run_live_local_copy(encoder: FFmpegDashEncoder, poll_interval: float = 2.0) -> None:
    """Transcode live and keep only the rolling window locally (and optionally mirrored elsewhere)."""

    publisher = LocalPublisher(
        target_dir=LOCAL_PUBLISH_TARGET, source_root=OUTPUT_DIR)
    pipeline = DashTranscodePipeline(
        encoder, publisher=publisher, poll_interval=poll_interval)
    handle = pipeline.start_live()
    _wait_for_completion(handle)


def run_live_http_publish(encoder: FFmpegDashEncoder, poll_interval: float = 2.0) -> None:
    """Transcode live and push the rolling window to a remote HTTP endpoint via PUT/DELETE."""

    publisher = HttpPutPublisher(
        base_url=HTTP_BASE_URL,
        source_root=OUTPUT_DIR,
        enable_delete=True,
    )
    pipeline = DashTranscodePipeline(
        encoder, publisher=publisher, poll_interval=poll_interval)
    handle = pipeline.start_live()
    _wait_for_completion(handle)


def _wait_for_completion(handle: LiveEncodingHandle) -> None:
    LOGGER.info(
        "Live encoding started (PID: %s). Press Ctrl+C to stop.", handle.process.pid)
    try:
        handle.wait()
    except KeyboardInterrupt:
        LOGGER.info("KeyboardInterrupt received; shutting down FFmpeg")
        handle.process.send_signal(signal.SIGINT)
        handle.wait()
    LOGGER.info("FFmpeg exited with %s", handle.process.returncode)


def main() -> None:
    encoder = build_encoder()
    preview_encoder(encoder)

    RUN_LIVE_LOCAL = True
    RUN_LIVE_HTTP = False

    if RUN_LIVE_LOCAL:
        run_live_local_copy(encoder)
    if RUN_LIVE_HTTP:
        run_live_http_publish(encoder)


if __name__ == "__main__":
    main()
