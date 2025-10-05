#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

REPO_ROOT=$(cd "$ROOT_DIR/../.." && pwd)
if [[ -z "${TRANSCODER_SKIP_DOTENV:-}" ]]; then
  DOTENV_HELPER="$REPO_ROOT/load-dotenv.sh"
  if [[ -f "$DOTENV_HELPER" ]]; then
    # shellcheck disable=SC1091
    source "$DOTENV_HELPER" "$ROOT_DIR"
  fi
fi

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:${PYTHONPATH:-}"
export FLASK_RUN_HOST="${FLASK_RUN_HOST:-${TRANSCODER_INGEST_HOST:-0.0.0.0}}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-${TRANSCODER_INGEST_PORT:-5005}}"

export INGEST_LOG_DIR="${INGEST_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$INGEST_LOG_DIR"

media_root="${INGEST_OUTPUT_DIR:-${TRANSCODER_OUTPUT:-${TRANSCODER_SHARED_OUTPUT_DIR:-$HOME/ingest_data}}}"
if [[ -n "$media_root" ]]; then
  mkdir -p "$media_root"
fi

if [[ -z "${GUNICORN_WORKER_CLASS:-}" && -n "${INGEST_GUNICORN_WORKER_CLASS:-}" ]]; then
  GUNICORN_WORKER_CLASS="$INGEST_GUNICORN_WORKER_CLASS"
fi
GUNICORN_WORKER_CLASS="${GUNICORN_WORKER_CLASS:-eventlet}"

CPU_CORES="${TRANSCODER_CPU_CORES:-}"
if [[ -z "$CPU_CORES" ]]; then
  if command -v nproc >/dev/null 2>&1; then
    CPU_CORES=$(nproc --all)
  else
    CPU_CORES=$("$PYTHON_BIN" - <<'PY'
import os
print(os.cpu_count() or 1)
PY
    )
  fi
fi

if ! [[ "$CPU_CORES" =~ ^[0-9]+$ ]]; then
  CPU_CORES=1
fi

if (( CPU_CORES < 1 )); then
  CPU_CORES=1
fi

DEFAULT_SYNC_WORKERS=$(( CPU_CORES * 2 + 1 ))
DEFAULT_ASYNC_WORKERS=$CPU_CORES
DEFAULT_WORKERS=$DEFAULT_SYNC_WORKERS

case "$GUNICORN_WORKER_CLASS" in
  eventlet|gevent|geventlet|gthread|uvicorn.workers.UvicornWorker|uvicorn.workers.UvicornH11Worker)
    DEFAULT_WORKERS=$DEFAULT_ASYNC_WORKERS
    ;;
esac

if [[ -z "${GUNICORN_WORKERS:-}" && -n "${INGEST_GUNICORN_WORKERS:-}" ]]; then
  GUNICORN_WORKERS="$INGEST_GUNICORN_WORKERS"
fi

if [[ -z "${GUNICORN_WORKERS:-}" ]]; then
  if [[ -n "${WEB_CONCURRENCY:-}" ]]; then
    GUNICORN_WORKERS="$WEB_CONCURRENCY"
  else
    GUNICORN_WORKERS="$DEFAULT_WORKERS"
  fi
fi

if [[ "$GUNICORN_WORKER_CLASS" == "gthread" && -z "${GUNICORN_THREADS:-}" ]]; then
  GUNICORN_THREADS="${INGEST_GUNICORN_THREADS:-8}"
fi

if [[ -z "${GUNICORN_WORKER_CONNECTIONS:-}" && -n "${INGEST_GUNICORN_WORKER_CONNECTIONS:-}" ]]; then
  GUNICORN_WORKER_CONNECTIONS="$INGEST_GUNICORN_WORKER_CONNECTIONS"
fi

if [[ -z "${GUNICORN_WORKER_CONNECTIONS:-}" ]]; then
  case "$GUNICORN_WORKER_CLASS" in
    eventlet|gevent|geventlet)
      GUNICORN_WORKER_CONNECTIONS=$(( CPU_CORES * 200 ))
      ;;
  esac
fi

if [[ -x "$ROOT_DIR/venv/bin/gunicorn" ]]; then
  GUNICORN_CMD=("$ROOT_DIR/venv/bin/gunicorn")
elif command -v gunicorn >/dev/null 2>&1; then
  GUNICORN_CMD=("$(command -v gunicorn)")
else
  GUNICORN_CMD=("$PYTHON_BIN" "-m" "gunicorn")
fi

GUNICORN_ARGS=(
  --workers "$GUNICORN_WORKERS"
  --worker-class "$GUNICORN_WORKER_CLASS"
)

if [[ -n "${GUNICORN_THREADS:-}" ]]; then
  GUNICORN_ARGS+=(--threads "$GUNICORN_THREADS")
fi

if [[ -n "${GUNICORN_WORKER_CONNECTIONS:-}" ]]; then
  GUNICORN_ARGS+=(--worker-connections "$GUNICORN_WORKER_CONNECTIONS")
fi

GUNICORN_ARGS+=(
  --bind "$FLASK_RUN_HOST:$FLASK_RUN_PORT"
  --chdir "$ROOT_DIR"
  "src.wsgi:app"
)

exec "${GUNICORN_CMD[@]}" "${GUNICORN_ARGS[@]}"
