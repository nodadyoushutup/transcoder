# Agent Notes

## Development Loop
Follow a **plan → build → test → learn → repeat** rhythm for every change:

1. **Plan** – Analyze the task, inspect relevant docs or logs, form a hypothesis, and outline the steps you expect to take. Only move forward once you have a clear approach.
2. **Build** – Apply the planned edits (update the task plan, write code, keep changes focused).
3. **Test** – Exercise the pipeline manually.
 - `core/api/scripts/run.sh`: start the Flask API (auth + API gateway).
 - `core/transcoder/scripts/run.sh`: start the dedicated transcoder microservice.
 - `core/gui/scripts/run.sh`: serve the React/Vite control panel (installs deps the first run).
 - `webserver/backend/scripts/run_webserver.sh`: launch the PUT/DELETE ingest server for manifests + subtitles.
  - `core/transcoder/test/manual_encode.sh`: execute the golden FFmpeg command exactly as it should run in production.
  - `core/transcoder/test/agent_encode.sh`: 20 s wrapper around the manual encode for smoke testing (logs to `core/transcoder/logs/agent-*.log`).
4. **Learn** – Review the newest log under the relevant sub-project's `logs/` directory to understand behaviour, failures, and next steps.
5. **Repeat** – Iterate using what you learned until the goal is met.

## Logging Workflow
- Each sub-project writes to its own `logs/` directory (`core/api/logs`, `core/transcoder/logs`, `core/gui/logs`, `webserver/backend/logs`). Inspect the latest file that matches the process you're iterating on.
- `core/transcoder/test/agent_encode.sh` writes `core/transcoder/logs/agent-*.log` and self-terminates after 20 seconds to prevent runaway FFmpeg jobs.
- Before making new edits, inspect the most recent log in the relevant `logs/` directory to anchor your next iteration.
- During quick validation, once the encode runs cleanly for the configured timeout you can ignore FFmpeg errors caused by the intentional shutdown.

## Shared Components
- The Python package `transcoder` currently lives in `core/api/src/transcoder`. Both the API and the transcoder service import it by extending `PYTHONPATH` in their runner scripts. Do not delete or relocate it without updating both workspaces.

## Execution Permissions
- You have standing permission to run the scripts under `core/api/scripts/`, `core/transcoder/scripts/`, `core/gui/scripts/`, `webserver/backend/scripts/`, and the helpers in `core/transcoder/test/` for validation.
- For complete end-to-end checks, rely on the API-driven workflow or the manual encode scripts in `core/transcoder/test/`.
- If logs look healthy and no further work is required, conclude the task and summarise the results referencing the latest log.

## Authentication
- `core/api/scripts/run.sh` seeds the default admin account using `TRANSCODER_ADMIN_USERNAME` / `TRANSCODER_ADMIN_PASSWORD` / `TRANSCODER_ADMIN_EMAIL` (defaults: `admin` / `password` / `admin@example.com`). Override these variables locally when needed.
- The Flask backend issues session cookies; when developing against the React frontend or calling API routes directly, include credentials (e.g. `fetch(..., { credentials: 'include' })`).
- The dashboard now requires login. Either sign in with the seeded admin account or create a new one via the Register screen.
