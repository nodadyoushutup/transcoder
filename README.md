# dash-transcoder

Utilities for orchestrating FFmpeg to produce DASH output suited for consumption in modern web players. The repository now hosts two deployable sub-projects that will eventually become independent containers.

## Features

- Probes an input source with `ffprobe` to discover video and audio streams, mapping them into DASH adaptation sets with deterministic naming.
- Ships a proven FFmpeg profile (`core/backend/test/manual_encode.sh`) that targets low-latency H.264/AAC output via DASH.
- Provides a Flask backend that exposes REST endpoints to start/stop the transcoder in a background thread.
- Bundles a Vite/React frontend that mirrors the dash.js single-player experience with play/stop controls wired to the backend.
- Includes a dedicated webserver Flask app that accepts HTTP PUT/DELETE uploads and assembles a `master.mpd` on-the-fly by combining the live `audio_video.mpd` with any WebVTT subtitles present in its public directory.

## Project Layout

- `core/backend/src/transcoder`: Core FFmpeg orchestration library.
- `core/backend/app`: Flask API for auth and orchestration.
- `core/transcoder/app`: Flask microservice that runs the transcoder pipeline.
- `core/transcoder/test`: Shell helpers (`manual_encode.sh`, `agent_encode.sh`) that mirror the production encoder settings.
- `core/frontend`: Vite + React control panel.
- `webserver/backend/src/webserver_app`: HTTP PUT ingest service that stores media and synthesises the master manifest.

Each sub-project (`core/backend`, `core/frontend`, `webserver/backend`) owns its own `logs/` directory and runner scripts.

## Requirements

- Python 3.10+
- A working `ffmpeg` build with DASH support (`--enable-libxml2` and `--enable-openssl` recommended)
- Node.js 18+ (or later) with npm for the frontend workspace
- Project-specific Python dependencies listed in:
  - `core/backend/requirements.txt`
  - `webserver/backend/requirements.txt`

## Setup

### Core backend (Flask + transcoder)

```bash
cd core/backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Webserver ingest app

```bash
cd webserver/backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Frontend workspace

```bash
cd core/frontend
npm install
```

## Running the stack

1. Start the ingest server (optional): `webserver/backend/scripts/run_webserver.sh`
2. Start the core backend: `core/backend/scripts/run_backend.sh`
3. Launch the React UI: `core/frontend/scripts/run_frontend.sh`

If `TRANSCODER_PUBLISH_BASE_URL` is set (e.g. `http://localhost:8080/content/`), the transcoder mirrors outputs to that endpoint via HTTP PUT so the webserver can serve `master.mpd`.

If the publish URL is omitted, the backend exposes the live manifest directly at `http://<backend-host>:5001/media/audio_video.mpd` (and the corresponding segments beneath `/media/`). Override `TRANSCODER_LOCAL_MEDIA_BASE_URL` if you need a custom external URL, otherwise the backend derives it from the incoming request.

The frontend still honours `VITE_BACKEND_URL` (default `http://localhost:5001`). You can override `VITE_STREAM_URL` to hardcode a manifest location, but by default it follows whatever the backend reports.

For quick CLI testing, run the harness from the backend project:

```bash
cd core/backend
PYTHONPATH=src python run.py
```

## Sample players

- `examples/dashjs_multi.html`: two synchronized dash.js players for monitoring multiple viewpoints.
- `examples/dashjs_single.html`: a full-viewport dash.js player for quick validation.

## Roadmap ideas

1. Support multiple transcoding presets with queue management in the backend API.
2. Expand the frontend into an operator dashboard (history, metrics, embedded preview).
3. Add integration tests that exercise PUT/DELETE flows against the ingest server (including subtitle overlays).
4. Harden publishing paths with pluggable cloud storage drivers and retries.

## Development

- Lint the backend: `ruff check core/backend/src`
- Type-check the backend: `mypy core/backend/src`
- Execute unit tests (when present): `pytest`

Use the shell helpers in `core/backend/test/` for manual FFmpeg validation (`manual_encode.sh` or `agent_encode.sh`).

## License

MIT (see `LICENSE` – add your preferred license text).
