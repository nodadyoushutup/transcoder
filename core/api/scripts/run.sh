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

# Redis-backed Socket.IO supports multiple workers. Choose sane defaults based on
# CPU count so the API scales without manual tuning; override GUNICORN_* env vars
# to customize.
GUNICORN_WORKER_CLASS="${GUNICORN_WORKER_CLASS:-eventlet}"

CPU_CORES="${TRANSCODER_CPU_CORES:-}"
if [[ -z "$CPU_CORES" ]]; then
  if command -v nproc >/dev/null 2>&1; then
    CPU_CORES=$(nproc --all)
  else
    CPU_CORES=$("$PYTHON_BIN" - <<'PY'
import os
cores = os.cpu_count() or 1
print(cores)
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

if [[ -z "${GUNICORN_WORKERS:-}" ]]; then
  if [[ -n "${WEB_CONCURRENCY:-}" ]]; then
    GUNICORN_WORKERS="$WEB_CONCURRENCY"
  else
    GUNICORN_WORKERS="$DEFAULT_WORKERS"
  fi
fi

if [[ "$GUNICORN_WORKER_CLASS" == "gthread" && -z "${GUNICORN_THREADS:-}" ]]; then
  GUNICORN_THREADS=4
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

GUNICORN_ARGS+=(
  --bind "$FLASK_RUN_HOST:$FLASK_RUN_PORT"
  --chdir "$ROOT_DIR"
  "src.wsgi:app"
)

# Launch Celery worker alongside Gunicorn so a single entrypoint powers both the
# API and background jobs. Set ENABLE_EMBEDDED_CELERY=0 to skip when embedding in
# other process managers (tests, etc.).
ENABLE_EMBEDDED_CELERY="${ENABLE_EMBEDDED_CELERY:-1}"
START_CELERY=1
case "${ENABLE_EMBEDDED_CELERY,,}" in
  0|"false"|"no"|"off")
    START_CELERY=0
    ;;
esac

declare -a PROC_PIDS=()
declare -A PID_LABEL=()

terminate_children() {
  local signal="${1:-TERM}"
  for pid in "${PROC_PIDS[@]}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

cleanup() {
  trap - EXIT
  terminate_children TERM
}

on_signal() {
  cleanup
  exit 1
}

trap on_signal INT TERM
trap cleanup EXIT

if [[ $START_CELERY -eq 1 ]]; then
  CELERY_LAUNCHER="$ROOT_DIR/scripts/celery_worker.sh"
  if [[ ! -x "$CELERY_LAUNCHER" ]]; then
    echo "Celery helper $CELERY_LAUNCHER not found or not executable." >&2
    exit 1
  fi
  DEFAULT_EMBEDDED_CELERY_QUEUES="transcoder,library_sections"
  CELERY_WORKER_QUEUE_VALUE="${CELERY_WORKER_QUEUE:-$DEFAULT_EMBEDDED_CELERY_QUEUES}"
  CELERY_WORKER_QUEUE="$CELERY_WORKER_QUEUE_VALUE" "$CELERY_LAUNCHER" &
  CELERY_PID=$!
  PROC_PIDS+=("$CELERY_PID")
  PID_LABEL[$CELERY_PID]="celery"
fi

"${GUNICORN_CMD[@]}" "${GUNICORN_ARGS[@]}" &
GUNICORN_PID=$!
PROC_PIDS+=("$GUNICORN_PID")
PID_LABEL[$GUNICORN_PID]="gunicorn"

ACTIVE_PIDS=("${PROC_PIDS[@]}")
EXIT_CODE=0
FINISHED_PID=""
FINISHED_NAME=""

while ((${#ACTIVE_PIDS[@]})); do
  status=0
  if ! wait -n "${ACTIVE_PIDS[@]}"; then
    status=$?
  fi
  EXIT_CODE=$status
  FINISHED_PID=""
  NEXT_ACTIVE=()
  for pid in "${ACTIVE_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      NEXT_ACTIVE+=("$pid")
    else
      FINISHED_PID="$pid"
    fi
  done
  ACTIVE_PIDS=("${NEXT_ACTIVE[@]}")
  if [[ -n "$FINISHED_PID" ]]; then
    FINISHED_NAME=${PID_LABEL[$FINISHED_PID]:-process}
    break
  fi
done

if [[ ${EXIT_CODE} -ne 0 ]]; then
  echo "${FINISHED_NAME^} exited with status ${EXIT_CODE}. Shutting down remaining services." >&2
fi

terminate_children TERM
for pid in "${PROC_PIDS[@]}"; do
  if [[ -n "${pid:-}" ]]; then
    wait "$pid" 2>/dev/null || true
  fi
done

exit "$EXIT_CODE"
