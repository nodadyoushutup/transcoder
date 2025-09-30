#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

export PYTHONPATH="$ROOT_DIR/src:${PYTHONPATH:-}"
export FLASK_APP="transcoder_backend.app:create_app"
export FLASK_RUN_HOST="${FLASK_RUN_HOST:-0.0.0.0}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-5001}"

export TRANSCODER_BACKEND_LOG_DIR="${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$TRANSCODER_BACKEND_LOG_DIR"

exec "$PYTHON_BIN" -m flask run
