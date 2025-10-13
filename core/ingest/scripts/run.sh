#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

REPO_ROOT=$(cd "$ROOT_DIR/../.." && pwd)
if [[ -z "${INGEST_SKIP_DOTENV:-}" ]]; then
  DOTENV_HELPER="$REPO_ROOT/load-dotenv.sh"
  if [[ -f "$DOTENV_HELPER" ]]; then
    # shellcheck disable=SC1091
    source "$DOTENV_HELPER" "$ROOT_DIR"
  fi
fi

export PYTHONPATH="$ROOT_DIR/src:${PYTHONPATH:-}"

export INGEST_HOST="${INGEST_HOST:-0.0.0.0}"
export INGEST_PORT="${INGEST_PORT:-5005}"

if [[ -z "${INGEST_ROOT:-}" ]]; then
  if [[ -n "${TRANSCODER_SHARED_OUTPUT_DIR:-}" ]]; then
    export INGEST_ROOT="$TRANSCODER_SHARED_OUTPUT_DIR"
  else
    export INGEST_ROOT="$HOME/ingest_data"
  fi
fi

WORKERS="${INGEST_WORKERS:-4}"
if [[ -z "$WORKERS" || "$WORKERS" -lt 1 ]]; then
  WORKERS=4
fi

TIMEOUT="${INGEST_TIMEOUT:-120}"

if [[ -x "$ROOT_DIR/venv/bin/gunicorn" ]]; then
  GUNICORN_CMD=("$ROOT_DIR/venv/bin/gunicorn")
elif command -v gunicorn >/dev/null 2>&1; then
  GUNICORN_CMD=("$(command -v gunicorn)")
else
  GUNICORN_CMD=("$PYTHON_BIN" "-m" "gunicorn")
fi

LOG_DIR="${INGEST_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
export INGEST_LOG_DIR="$LOG_DIR"
if [[ -z "${TRANSCODER_BACKEND_LOG_DIR:-}" ]]; then
  export TRANSCODER_BACKEND_LOG_DIR="$LOG_DIR"
fi

if [[ -n "${INGEST_ACCESS_LOG:-}" ]]; then
  ACCESS_LOG_TARGET="$INGEST_ACCESS_LOG"
else
  ACCESS_LOG_TARGET="-"
fi

if [[ -n "${INGEST_ERROR_LOG:-}" ]]; then
  ERROR_LOG_TARGET="$INGEST_ERROR_LOG"
else
  ERROR_LOG_TARGET="-"
fi

if [[ "$ACCESS_LOG_TARGET" != "-" ]]; then
  mkdir -p "$(dirname "$ACCESS_LOG_TARGET")"
fi
if [[ "$ERROR_LOG_TARGET" != "-" ]]; then
  mkdir -p "$(dirname "$ERROR_LOG_TARGET")"
fi

SERVER_ARGS=(
  --workers "$WORKERS"
  --worker-class sync
  --bind "$INGEST_HOST:$INGEST_PORT"
  --timeout "$TIMEOUT"
  --access-logfile "$ACCESS_LOG_TARGET"
  --error-logfile "$ERROR_LOG_TARGET"
  --chdir "$ROOT_DIR"
  "src.wsgi:app"
)

exec "${GUNICORN_CMD[@]}" "${SERVER_ARGS[@]}"
