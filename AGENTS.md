# Agent Notes

## Development Loop
Follow a **plan → build → test → learn → repeat** rhythm for every change:

1. **Plan** – Analyze the task, inspect relevant docs or logs, form a hypothesis, and outline the steps you expect to take. Only move forward once you have a clear approach.
2. **Build** – Apply the planned edits (update the task plan, write code, keep changes focused).
3. **Test** – Exercise the pipeline manually.
   - `core/backend/scripts/run_backend.sh`: start the Flask backend that owns the transcoder thread.
   - `core/frontend/scripts/run_frontend.sh`: serve the React/Vite control panel (installs deps the first run).
   - `webserver/backend/scripts/run_webserver.sh`: launch the PUT/DELETE ingest server for manifests + subtitles.
   - `core/backend/test/manual_encode.sh`: execute the golden FFmpeg command exactly as it should run in production.
   - `core/backend/test/agent_encode.sh`: 20 s wrapper around the manual encode for smoke testing.
4. **Learn** – Review the newest log under the relevant sub-project's `logs/` directory to understand behaviour, failures, and next steps.
5. **Repeat** – Iterate using what you learned until the goal is met.

## Logging Workflow
- Each sub-project writes to its own `logs/` directory (`core/backend/logs`, `core/frontend/logs`, `webserver/backend/logs`). Inspect the latest file that matches the process you're iterating on.
- `core/backend/test/agent_encode.sh` writes `core/backend/logs/agent-*.log` and self-terminates after 20 seconds to prevent runaway FFmpeg jobs.
- Before making new edits, inspect the most recent log in the relevant `logs/` directory to anchor your next iteration.
- During quick validation, once the encode runs cleanly for the configured timeout you can ignore FFmpeg errors caused by the intentional shutdown.

## Execution Permissions
- You have standing permission to run the scripts under `core/backend/scripts/`, `core/frontend/scripts/`, `webserver/backend/scripts/`, and the helpers in `core/backend/test/` for validation.
- For complete end-to-end checks, rely on the backend-driven workflow or the manual encode scripts in `core/backend/test/`.
- If logs look healthy and no further work is required, conclude the task and summarise the results referencing the latest log.
