# Backend encode helpers

This directory intentionally keeps only the two FFmpeg helpers that mirror the production pipeline:

- `manual_encode.sh` – the canonical FFmpeg command; it should remain unchanged.
- `agent_encode.sh` – a 20 s wrapper around `manual_encode.sh` that collects logs under `core/backend/logs/` for quick smoke checks.

Use `core/backend/scripts/run_backend.sh` for normal development runs (it now seeds the default admin login and configures Flask). Reach for these helpers only when you need to reproduce the raw encode behaviour outside the Flask service.

Logs from `agent_encode.sh` are written as `core/backend/logs/agent-*.log`.
