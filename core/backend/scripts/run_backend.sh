#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:${PYTHONPATH:-}"
export FLASK_APP="app:create_app"
export FLASK_RUN_HOST="${FLASK_RUN_HOST:-0.0.0.0}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-5001}"

export TRANSCODER_BACKEND_LOG_DIR="${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$TRANSCODER_BACKEND_LOG_DIR"

export TRANSCODER_ADMIN_USERNAME="${TRANSCODER_ADMIN_USERNAME:-admin}"
export TRANSCODER_ADMIN_PASSWORD="${TRANSCODER_ADMIN_PASSWORD:-password}"
export TRANSCODER_ADMIN_EMAIL="${TRANSCODER_ADMIN_EMAIL:-admin@example.com}"
export TRANSCODER_SECRET_KEY="${TRANSCODER_SECRET_KEY:-dev-change-me}"
export TRANSCODER_SERVICE_URL="${TRANSCODER_SERVICE_URL:-http://localhost:5003}"

if [[ -n "${TRANSCODER_DATABASE_URI:-}" ]]; then
  export TRANSCODER_DATABASE_URI
fi

exec "$PYTHON_BIN" -m flask run
