#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_BIN="$ROOT_DIR/venv/bin/celery"
PYTHON_BIN="python3"
CELERY_BIN="celery"

if [[ -x "$VENV_BIN" ]]; then
  CELERY_BIN="$VENV_BIN"
elif command -v celery >/dev/null 2>&1; then
  CELERY_BIN=$(command -v celery)
else
  echo "Celery executable not found. Install dependencies first." >&2
  exit 1
fi

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:${PYTHONPATH:-}"

LOG_DIR="${TRANSCODER_API_LOG_DIR:-${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}}"
mkdir -p "$LOG_DIR"

LOG_LEVEL="${CELERY_LOG_LEVEL:-info}"
WORKER_QUEUE="${CELERY_WORKER_QUEUE:-transcoder}"
LIBRARY_QUEUE="${CELERY_LIBRARY_QUEUE:-library_sections}"
WORKER_CONCURRENCY="${CELERY_WORKER_CONCURRENCY:-}"

if [[ -z "$WORKER_CONCURRENCY" && "$WORKER_QUEUE" == "$LIBRARY_QUEUE" ]]; then
  WORKER_CONCURRENCY=4
fi

CELERY_ARGS=(
  --app core.api.src.celery_app:celery_app
  worker
  --loglevel "$LOG_LEVEL"
  --queues "$WORKER_QUEUE"
)

if [[ -n "$WORKER_CONCURRENCY" ]]; then
  CELERY_ARGS+=(--concurrency "$WORKER_CONCURRENCY")
fi

exec "$CELERY_BIN" "${CELERY_ARGS[@]}"
