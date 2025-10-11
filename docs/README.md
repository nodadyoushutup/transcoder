# dash-transcoder

Utilities for orchestrating FFmpeg to produce DASH output suited for consumption in modern web players. The repository now hosts three deployable sub-projects that will eventually become independent containers.

## Features

- Probes an input source with `ffprobe` to discover video and audio streams, mapping them into DASH adaptation sets with deterministic naming.
- Ships a configurable FFmpeg pipeline whose defaults are persisted in the database-backed System Settings UI.
- Provides a Flask API that handles auth + state and proxies transcoder commands to the dedicated microservice.
- Ships a standalone Flask transcoder service that orchestrates FFmpeg using the shared `transcoder` library.
- Bundles a Vite/React GUI that mirrors the dash.js single-player experience with play/stop controls wired to the backend.
- Includes a Dockerised Nginx + WebDAV origin (see `docker/`) for serving packaged manifests/segments, replacing the bespoke ingest Flask app for the default workflow.
- Links an administrator's Plex account via OAuth so future releases can surface Plex libraries inside the control panel.

## Project Layout

- `core/api/src/transcoder`: Shared FFmpeg orchestration library consumed by both services (temporarily housed here).
- `core/api/src`: Flask API for auth and orchestration/proxy logic.
- `core/transcoder/src`: Flask microservice that runs the transcoder pipeline on behalf of the API.
- `core/transcoder/test`: Legacy smoke-test helpers are retired; consult the System Settings data for the effective encoder configuration.
- `core/gui`: Vite + React control panel.

Each sub-project (`core/api`, `core/transcoder`, `core/gui`) owns its own `logs/` directory and runner scripts.

Note: Until the shared library is broken out into its own package, both `core/api/scripts/run.sh` and `core/transcoder/scripts/run.sh` extend `PYTHONPATH` so the `transcoder` module resolves from `core/api/src/transcoder`.

## Requirements

- Python 3.10+
- A working `ffmpeg` build with DASH support (`--enable-libxml2` and `--enable-openssl` recommended)
- Node.js 18+ (or later) with npm for the frontend workspace
- Project-specific Python dependencies listed in:
- `core/api/requirements.txt`
- `core/transcoder/requirements.txt`
- Docker (for the Nginx + WebDAV media origin defined in `docker/docker-compose.yml`)

## Setup

### Core API (Flask + transcoder)

```bash
cd core/api
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

1. Start the media origin (`docker/docker-compose.yml` exposes Nginx + WebDAV on port `5005`): `cd docker && docker compose up -d`
2. Start the transcoder service (automatically launches the upload watchdog): `core/transcoder/scripts/run.sh`
3. Start the Celery worker that handles background jobs: `core/api/scripts/celery_worker.sh`
4. Start the Celery beat scheduler (periodically refreshes Plex snapshots): `core/api/scripts/celery_beat.sh`
5. Start the core API (proxies requests to the service): `core/api/scripts/run.sh`
6. Launch the React UI: `core/gui/scripts/run.sh`

When `TRANSCODER_PUBLISH_BASE_URL` (or `WATCHDOG_UPLOAD_URL`) points at the Nginx origin (default `http://localhost:5005/media`), the watchdog service launched by the transcoder mirrors new segments via HTTP PUT and delays manifest uploads until all chunks for the window land successfully.

If the publish URL is omitted, the transcoder still serves manifests from the local filesystem path returned in the `/transcode/status` payload – override `TRANSCODER_LOCAL_MEDIA_BASE_URL` if you need a custom external URL for direct file serving.

The frontend honours both `GUI_BACKEND_URL` (default `http://localhost:5001`) and `GUI_INGEST_URL` (default `http://localhost:5005`). You can override `GUI_STREAM_URL` to hardcode a manifest location; by default it mirrors the publish base reported by the backend.

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

The runner switches from Gunicorn to Hypercorn, reusing the Flask app through the new ASGI bridge (`core/api/src/app/entrypoints/http2.py`) and exposing it at `https://<host>:5443` with ALPN `h2,http/1.1`. Tweak `TRANSCODER_HTTP2_WORKERS`, `TRANSCODER_HTTP2_KEEPALIVE`, `TRANSCODER_HTTP2_LOG_LEVEL`, or `TRANSCODER_HTTP2_ACCESS_LOG` for additional tuning.

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

Trigger end-to-end validation through the API or GUI so the transcoder runs with the database-managed settings, then inspect `core/transcoder/logs/` for the resulting FFmpeg command.

## License

MIT (see `LICENSE` – add your preferred license text).
