# Transcoder encode helpers

This directory intentionally keeps only the two FFmpeg helpers that mirror the production pipeline:

- `manual_encode.sh` – the canonical FFmpeg command; it should remain unchanged.
- `agent_encode.sh` – a 20 s wrapper around `manual_encode.sh` that collects logs under `core/transcoder/logs/` for quick smoke checks.

Use `core/transcoder/scripts/run_transcoder.sh` when you need to run the microservice. Reach for these helpers only when you need to reproduce the raw encode behaviour outside the Flask services.

Logs from `agent_encode.sh` are written as `core/transcoder/logs/agent-*.log`.
