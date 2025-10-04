#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:${PYTHONPATH:-}"
export FLASK_RUN_HOST="${FLASK_RUN_HOST:-0.0.0.0}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-5001}"

LOG_DIR="${TRANSCODER_API_LOG_DIR:-${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}}"
export TRANSCODER_API_LOG_DIR="$LOG_DIR"
export TRANSCODER_BACKEND_LOG_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"

export TRANSCODER_ADMIN_USERNAME="${TRANSCODER_ADMIN_USERNAME:-admin}"
export TRANSCODER_ADMIN_PASSWORD="${TRANSCODER_ADMIN_PASSWORD:-password}"
export TRANSCODER_ADMIN_EMAIL="${TRANSCODER_ADMIN_EMAIL:-admin@example.com}"
export TRANSCODER_SECRET_KEY="${TRANSCODER_SECRET_KEY:-dev-change-me}"
export TRANSCODER_SERVICE_URL="${TRANSCODER_SERVICE_URL:-http://localhost:5003}"

if [[ -n "${TRANSCODER_DATABASE_URI:-}" ]]; then
  export TRANSCODER_DATABASE_URI
fi

# Redis-backed Socket.IO supports multiple workers. Default to two so the API
# can handle concurrent requests out of the box; override GUNICORN_WORKERS to scale.
GUNICORN_WORKERS="${GUNICORN_WORKERS:-4}"
GUNICORN_WORKER_CLASS="${GUNICORN_WORKER_CLASS:-eventlet}"

if [[ -x "$ROOT_DIR/venv/bin/gunicorn" ]]; then
  GUNICORN_CMD=("$ROOT_DIR/venv/bin/gunicorn")
elif command -v gunicorn >/dev/null 2>&1; then
  GUNICORN_CMD=("$(command -v gunicorn)")
else
  GUNICORN_CMD=("$PYTHON_BIN" "-m" "gunicorn")
fi

exec "${GUNICORN_CMD[@]}" \
  --workers "$GUNICORN_WORKERS" \
  --worker-class "$GUNICORN_WORKER_CLASS" \
  --bind "$FLASK_RUN_HOST:$FLASK_RUN_PORT" \
  --chdir "$ROOT_DIR" \
  "src.wsgi:app"
