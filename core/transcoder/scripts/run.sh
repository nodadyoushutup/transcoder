#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:$ROOT_DIR/../api/src:${PYTHONPATH:-}"
export FLASK_RUN_HOST="${FLASK_RUN_HOST:-0.0.0.0}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-5003}"

export TRANSCODER_SERVICE_LOG_DIR="${TRANSCODER_SERVICE_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$TRANSCODER_SERVICE_LOG_DIR"

GUNICORN_WORKERS="${GUNICORN_WORKERS:-4}"
GUNICORN_WORKER_CLASS="${GUNICORN_WORKER_CLASS:-sync}"

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
