# dash-transcoder

Utilities for orchestrating FFmpeg to produce DASH output suited for consumption in modern web players. The repository now hosts three deployable sub-projects that will eventually become independent containers.

## Features

- Probes an input source with `ffprobe` to discover video and audio streams, mapping them into DASH adaptation sets with deterministic naming.
- Ships a proven FFmpeg profile (`core/transcoder/test/manual_encode.sh`) that targets low-latency H.264/AAC output via DASH.
- Provides a Flask API that handles auth + state and proxies transcoder commands to the dedicated microservice.
- Ships a standalone Flask transcoder service that orchestrates FFmpeg using the shared `transcoder` library.
- Bundles a Vite/React GUI that mirrors the dash.js single-player experience with play/stop controls wired to the backend.
- Includes a dedicated ingest Flask app that accepts HTTP PUT/DELETE uploads for manifests/segments and serves them directly to players from `core/ingest/out/`.
- Links an administrator's Plex account via OAuth so future releases can surface Plex libraries inside the control panel.

## Project Layout

- `core/api/src/transcoder`: Shared FFmpeg orchestration library consumed by both services (temporarily housed here).
- `core/api/src`: Flask API for auth and orchestration/proxy logic.
- `core/transcoder/src`: Flask microservice that runs the transcoder pipeline on behalf of the API.
- `core/transcoder/test`: Shell helpers (`manual_encode.sh`, `agent_encode.sh`) that mirror the production encoder settings.
- `core/gui`: Vite + React control panel.
- `core/ingest/src`: Flask ingest service that exposes `/media` for manifest/segment GET/PUT/DELETE flows.

Each sub-project (`core/api`, `core/transcoder`, `core/ingest`, `core/gui`) owns its own `logs/` directory and runner scripts.

Note: Until the shared library is broken out into its own package, both `core/api/scripts/run.sh` and `core/transcoder/scripts/run.sh` extend `PYTHONPATH` so the `transcoder` module resolves from `core/api/src/transcoder`.

## Requirements

- Python 3.10+
- A working `ffmpeg` build with DASH support (`--enable-libxml2` and `--enable-openssl` recommended)
- Node.js 18+ (or later) with npm for the frontend workspace
- Project-specific Python dependencies listed in:
- `core/api/requirements.txt`
- `core/transcoder/requirements.txt`
- (optional) mirror Flask dependencies for the ingest service if you need a standalone environment.

## Setup

### Core API (Flask + transcoder)

```bash
cd core/api
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Ingest service

```bash
cd core/ingest
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

1. Start the ingest service: `core/ingest/scripts/run.sh`
2. Start the transcoder service: `core/transcoder/scripts/run.sh`
3. Start the Celery worker that handles background jobs: `core/api/scripts/celery_worker.sh`
4. Start the Celery beat scheduler (periodically refreshes Plex snapshots): `core/api/scripts/celery_beat.sh`
5. Start the core API (proxies requests to the service): `core/api/scripts/run.sh`
6. Launch the React UI: `core/gui/scripts/run.sh`

If `TRANSCODER_PUBLISH_BASE_URL` is set (e.g. `http://localhost:8080/content/`), the transcoder mirrors outputs to that endpoint via HTTP PUT so the ingest host (or CDN) can serve the DASH window.

If the publish URL is omitted, the ingest service exposes the live manifest directly at `http://<host>:5005/media/audio_video.mpd` (and the corresponding segments beneath `/media/`). Override `TRANSCODER_LOCAL_MEDIA_BASE_URL` if you need a custom external URL; otherwise the transcoder controller assumes the ingest service origin.

The frontend honours both `GUI_BACKEND_URL` (default `http://localhost:5001`) and `GUI_INGEST_URL` (default `http://localhost:5005`). You can override `GUI_STREAM_URL` to hardcode a manifest location, but by default it mirrors the ingest base reported by the backend.

### HTTP/2 frontend (optional)

To serve cached artwork over multiplexed HTTP/2, flip the API runner into Hypercorn mode:

1. Generate a local certificate (self-signed works for development):
   ```bash
   mkdir -p core/api/data/certs
   openssl req -x509 -newkey rsa:4096 -nodes \
     -keyout core/api/data/certs/http2-dev.key \
     -out core/api/data/certs/http2-dev.crt \
     -days 365 -subj "/CN=localhost"
   ```
2. Start the API with HTTP/2 enabled:
   ```bash
   TRANSCODER_HTTP2_ENABLED=1 \
   TRANSCODER_HTTP2_CERT=$PWD/core/api/data/certs/http2-dev.crt \
   TRANSCODER_HTTP2_KEY=$PWD/core/api/data/certs/http2-dev.key \
   TRANSCODER_HTTP2_PORT=5443 \
   core/api/scripts/run.sh
   ```

   Omit `TRANSCODER_HTTP2_PORT` to keep the default of `5443`.

The runner switches from Gunicorn to Hypercorn, reusing the Flask app through the new ASGI bridge (`core/api/src/http2_asgi.py`) and exposing it at `https://<host>:5443` with ALPN `h2,http/1.1`. Tweak `TRANSCODER_HTTP2_WORKERS`, `TRANSCODER_HTTP2_KEEPALIVE`, `TRANSCODER_HTTP2_LOG_LEVEL`, or `TRANSCODER_HTTP2_ACCESS_LOG` for additional tuning.

Point the GUI (or any client) at the HTTPS endpoint, for example:

```bash
GUI_BACKEND_URL=https://localhost:5443 core/gui/scripts/run.sh
```

Browsers trust self-signed certificates on `localhost` once you approve them; import the certificate into your trust store if necessary.

For quick CLI testing, the legacy harness in `core/api/run.py` still works for running FFmpeg directly:

```bash
cd core/api
PYTHONPATH=src python run.py
```

It imports the shared `transcoder` library just like the dedicated microservice. Treat it as a local diagnostic tool – the production workflow should go through the API → transcoder service path.

## Plex integration (admin only)

The System Settings screen now exposes a **Plex** section that lets the seeded administrator connect their Plex account with OAuth. The API now talks to Plex directly over HTTP, requesting JSON responses (`Accept: application/json`) and persisting the access token in the `system_settings` table for future calls.

Environment variables you can override before starting `core/api/scripts/run.sh`:

- `PLEX_CLIENT_IDENTIFIER` – unique client identifier registered with Plex (default `publex-transcoder`).
- `PLEX_PRODUCT` – product name shown during the OAuth flow (default `Publex Transcoder`).
- `PLEX_DEVICE_NAME` – device name displayed to the Plex user (default `Publex Admin Console`).
- `PLEX_PLATFORM` / `PLEX_VERSION` – metadata describing the calling application (defaults `Publex` / `1.0`).

To link Plex:

1. Sign in as the admin (`admin` / `password` by default) via the GUI.
2. Navigate to **System Settings → Plex**.
3. Click **Connect Plex**. A new window opens to `app.plex.tv`; complete the login there.
4. The page will automatically update once Plex returns the token. You can disconnect at any time with **Disconnect Plex**.

Only administrators or users with the `plex.settings.manage` permission can access these endpoints.

### Celery configuration

Background tasks depend on Redis; point Celery at the same broker/backend via:

- `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` – typically the Redis URL (defaults to the value stored in System Settings → Redis).
- `CELERY_DEFAULT_QUEUE` – queue name for workers (defaults to `transcoder`).
- `PLEX_SECTIONS_REFRESH_INTERVAL_SECONDS` – cadence for the beat job that rebuilds the Plex library snapshot (defaults to 300 seconds, set to `0` to disable automatic refresh).

The API automatically enqueues a snapshot refresh whenever Plex credentials or library settings change, keeping the cached sections payload hot for user requests.

### Task monitoring

The **System Settings → Tasks** panel surfaces the current Celery schedule and worker activity. From there you can:

- Inspect active, scheduled, and reserved jobs with runtimes and destinations.
- Adjust periodic job intervals or disable jobs entirely.
- Refresh the runtime snapshot or gracefully stop individual tasks when diagnostics call for it.

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
