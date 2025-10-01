# dash-transcoder

Utilities for orchestrating FFmpeg to produce DASH output suited for consumption in modern web players. The repository now hosts two deployable sub-projects that will eventually become independent containers.

## Features

- Probes an input source with `ffprobe` to discover video and audio streams, mapping them into DASH adaptation sets with deterministic naming.
- Ships a proven FFmpeg profile (`core/transcoder/test/manual_encode.sh`) that targets low-latency H.264/AAC output via DASH.
- Provides a Flask API that handles auth + state and proxies transcoder commands to the dedicated microservice.
- Ships a standalone Flask transcoder service that orchestrates FFmpeg using the shared `transcoder` library.
- Bundles a Vite/React GUI that mirrors the dash.js single-player experience with play/stop controls wired to the backend.
- Includes a dedicated webserver Flask app that accepts HTTP PUT/DELETE uploads and assembles a `master.mpd` on-the-fly by combining the live `audio_video.mpd` with any WebVTT subtitles present in its public directory.

## Project Layout

- `core/api/src/transcoder`: Shared FFmpeg orchestration library consumed by both services (temporarily housed here).
- `core/api/src`: Flask API for auth and orchestration/proxy logic.
- `core/transcoder/src`: Flask microservice that runs the transcoder pipeline on behalf of the API.
- `core/transcoder/test`: Shell helpers (`manual_encode.sh`, `agent_encode.sh`) that mirror the production encoder settings.
- `core/gui`: Vite + React control panel.
- `webserver/backend/src/webserver_app`: HTTP PUT ingest service that stores media and synthesises the master manifest.

Each sub-project (`core/api`, `core/gui`, `webserver/backend`) owns its own `logs/` directory and runner scripts.

Note: Until the shared library is broken out into its own package, both `core/api/scripts/run.sh` and `core/transcoder/scripts/run.sh` extend `PYTHONPATH` so the `transcoder` module resolves from `core/api/src/transcoder`.

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
2. Start the transcoder service: `core/transcoder/scripts/run.sh`
3. Start the core API (proxies requests to the service): `core/api/scripts/run.sh`
4. Launch the React UI: `core/gui/scripts/run.sh`

If `TRANSCODER_PUBLISH_BASE_URL` is set (e.g. `http://localhost:8080/content/`), the transcoder mirrors outputs to that endpoint via HTTP PUT so the webserver can serve `master.mpd`.

If the publish URL is omitted, the API exposes the live manifest directly at `http://<api-host>:5001/media/audio_video.mpd` (and the corresponding segments beneath `/media/`). Override `TRANSCODER_LOCAL_MEDIA_BASE_URL` if you need a custom external URL, otherwise the API derives it from the incoming request.

The frontend still honours `VITE_BACKEND_URL` (default `http://localhost:5001`). You can override `VITE_STREAM_URL` to hardcode a manifest location, but by default it follows whatever the backend reports.

For quick CLI testing, the legacy harness in `core/api/run.py` still works for running FFmpeg directly:

```bash
cd core/api
PYTHONPATH=src python run.py
```

It imports the shared `transcoder` library just like the dedicated microservice. Treat it as a local diagnostic tool – the production workflow should go through the API → transcoder service path.

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
