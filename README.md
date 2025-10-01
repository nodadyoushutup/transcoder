# dash-transcoder

Utilities for orchestrating FFmpeg to produce DASH output suited for consumption in modern web players. The repository now hosts two deployable sub-projects that will eventually become independent containers.

## Features

- Probes an input source with `ffprobe` to discover video and audio streams, mapping them into DASH adaptation sets with deterministic naming.
- Ships a proven FFmpeg profile (`core/transcoder/test/manual_encode.sh`) that targets low-latency H.264/AAC output via DASH.
- Provides a Flask API that exposes REST endpoints to start/stop the transcoder in a background thread.
- Bundles a Vite/React GUI that mirrors the dash.js single-player experience with play/stop controls wired to the backend.
- Includes a dedicated webserver Flask app that accepts HTTP PUT/DELETE uploads and assembles a `master.mpd` on-the-fly by combining the live `audio_video.mpd` with any WebVTT subtitles present in its public directory.

## Project Layout

- `core/api/src/transcoder`: Core FFmpeg orchestration library.
- `core/api/src`: Flask API for auth and orchestration.
- `core/transcoder/src`: Flask microservice that runs the transcoder pipeline.
- `core/transcoder/test`: Shell helpers (`manual_encode.sh`, `agent_encode.sh`) that mirror the production encoder settings.
- `core/gui`: Vite + React control panel.
- `webserver/backend/src/webserver_app`: HTTP PUT ingest service that stores media and synthesises the master manifest.

Each sub-project (`core/api`, `core/gui`, `webserver/backend`) owns its own `logs/` directory and runner scripts.

## Requirements

- Python 3.10+
- A working `ffmpeg` build with DASH support (`--enable-libxml2` and `--enable-openssl` recommended)
- Node.js 18+ (or later) with npm for the frontend workspace
- Project-specific Python dependencies listed in:
- `core/api/requirements.txt`
  - `webserver/backend/requirements.txt`

## Setup

### Core API (Flask + transcoder)

```bash
cd core/api
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

### GUI workspace

```bash
cd core/gui
npm install
```

## Running the stack

1. Start the ingest server (optional): `webserver/backend/scripts/run_webserver.sh`
2. Start the core API: `core/api/scripts/run.sh`
3. Launch the React UI: `core/gui/scripts/run.sh`

If `TRANSCODER_PUBLISH_BASE_URL` is set (e.g. `http://localhost:8080/content/`), the transcoder mirrors outputs to that endpoint via HTTP PUT so the webserver can serve `master.mpd`.

If the publish URL is omitted, the API exposes the live manifest directly at `http://<api-host>:5001/media/audio_video.mpd` (and the corresponding segments beneath `/media/`). Override `TRANSCODER_LOCAL_MEDIA_BASE_URL` if you need a custom external URL, otherwise the API derives it from the incoming request.

The frontend still honours `VITE_BACKEND_URL` (default `http://localhost:5001`). You can override `VITE_STREAM_URL` to hardcode a manifest location, but by default it follows whatever the backend reports.

For quick CLI testing, run the harness from the API project:

```bash
cd core/api
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

- Lint the API: `ruff check core/api/src`
- Type-check the API: `mypy core/api/src`
- Execute unit tests (when present): `pytest`

Use the shell helpers in `core/transcoder/test/` for manual FFmpeg validation (`manual_encode.sh` or `agent_encode.sh`).

## License

MIT (see `LICENSE` – add your preferred license text).
