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

export FLASK_RUN_HOST="${FLASK_RUN_HOST:-${TRANSCODER_API_HOST:-0.0.0.0}}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-${TRANSCODER_API_PORT:-5001}}"

LOG_DIR="${TRANSCODER_API_LOG_DIR:-${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}}"
export TRANSCODER_API_LOG_DIR="$LOG_DIR"
export TRANSCODER_BACKEND_LOG_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"

export TRANSCODER_ADMIN_USERNAME="${TRANSCODER_ADMIN_USERNAME:-admin}"
export TRANSCODER_ADMIN_PASSWORD="${TRANSCODER_ADMIN_PASSWORD:-password}"
export TRANSCODER_ADMIN_EMAIL="${TRANSCODER_ADMIN_EMAIL:-admin@example.com}"
export TRANSCODER_SECRET_KEY="${TRANSCODER_SECRET_KEY:-dev-change-me}"
TRANSCODER_SERVICE_HOST="${TRANSCODER_TRANSCODER_HOST:-localhost}"
TRANSCODER_SERVICE_PORT="${TRANSCODER_TRANSCODER_PORT:-5003}"
if [[ -z "${TRANSCODER_SERVICE_URL:-}" ]]; then
  export TRANSCODER_SERVICE_URL="http://${TRANSCODER_SERVICE_HOST}:${TRANSCODER_SERVICE_PORT}"
else
  export TRANSCODER_SERVICE_URL
fi

if [[ -n "${TRANSCODER_DATABASE_URI:-}" ]]; then
  export TRANSCODER_DATABASE_URI
fi

# Toggle Hypercorn + HTTP/2 frontend by setting TRANSCODER_HTTP2_ENABLED to a truthy value.
HTTP2_ENABLED=0
case "${TRANSCODER_HTTP2_ENABLED:-}" in
  1|true|TRUE|yes|YES|on|ON)
    HTTP2_ENABLED=1
    ;;
esac

# Redis-backed Socket.IO supports multiple workers. Choose sane defaults based on
# CPU count so the API scales without manual tuning; override GUNICORN_* env vars
# to customize.
if [[ -z "${GUNICORN_WORKER_CLASS:-}" && -n "${API_GUNICORN_WORKER_CLASS:-}" ]]; then
  GUNICORN_WORKER_CLASS="$API_GUNICORN_WORKER_CLASS"
fi
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

if [[ -z "${GUNICORN_WORKERS:-}" && -n "${API_GUNICORN_WORKERS:-}" ]]; then
  GUNICORN_WORKERS="$API_GUNICORN_WORKERS"
fi

if [[ -z "${GUNICORN_WORKERS:-}" ]]; then
  if [[ -n "${WEB_CONCURRENCY:-}" ]]; then
    GUNICORN_WORKERS="$WEB_CONCURRENCY"
  else
    GUNICORN_WORKERS="$DEFAULT_WORKERS"
  fi
fi

if [[ -z "${GUNICORN_THREADS:-}" && -n "${API_GUNICORN_THREADS:-}" ]]; then
  GUNICORN_THREADS="$API_GUNICORN_THREADS"
fi

if [[ "$GUNICORN_WORKER_CLASS" == "gthread" && -z "${GUNICORN_THREADS:-}" ]]; then
  GUNICORN_THREADS=4
fi

SERVER_LABEL=""
SERVER_CMD=()
SERVER_ARGS=()

if [[ $HTTP2_ENABLED -eq 1 ]]; then
  HTTP2_HOST="${TRANSCODER_HTTP2_HOST:-$FLASK_RUN_HOST}"
  HTTP2_PORT="${TRANSCODER_HTTP2_PORT:-5443}"
  HTTP2_CERT="${TRANSCODER_HTTP2_CERT:-}"
  HTTP2_KEY="${TRANSCODER_HTTP2_KEY:-}"
  if [[ -z "$HTTP2_CERT" || -z "$HTTP2_KEY" ]]; then
    cat <<'EOF' >&2
HTTP/2 mode requires TLS materials. Set TRANSCODER_HTTP2_CERT and TRANSCODER_HTTP2_KEY
to the absolute paths of your certificate and private key.
EOF
    exit 1
  fi

  if [[ -x "$ROOT_DIR/venv/bin/hypercorn" ]]; then
    SERVER_CMD=("$ROOT_DIR/venv/bin/hypercorn")
  elif command -v hypercorn >/dev/null 2>&1; then
    SERVER_CMD=("$(command -v hypercorn)")
  else
    SERVER_CMD=("$PYTHON_BIN" "-m" "hypercorn")
  fi

  HTTP2_WORKERS="${TRANSCODER_HTTP2_WORKERS:-}"
  if [[ -z "$HTTP2_WORKERS" ]]; then
    HTTP2_WORKERS="$DEFAULT_ASYNC_WORKERS"
  fi

  SERVER_LABEL="hypercorn"
  SERVER_ARGS+=(
    --bind "$HTTP2_HOST:$HTTP2_PORT"
    --workers "$HTTP2_WORKERS"
    --certfile "$HTTP2_CERT"
    --keyfile "$HTTP2_KEY"
    --keep-alive "${TRANSCODER_HTTP2_KEEPALIVE:-20}"
  )

  if [[ -n "${TRANSCODER_HTTP2_LOG_LEVEL:-}" ]]; then
    SERVER_ARGS+=(--log-level "${TRANSCODER_HTTP2_LOG_LEVEL}")
  fi

  if [[ -n "${TRANSCODER_HTTP2_ACCESS_LOG:-}" ]]; then
    SERVER_ARGS+=(--access-log "${TRANSCODER_HTTP2_ACCESS_LOG}")
  else
    SERVER_ARGS+=(--access-log -)
  fi

  if [[ -n "${TRANSCODER_HTTP2_ERROR_LOG:-}" ]]; then
    SERVER_ARGS+=(--error-log "${TRANSCODER_HTTP2_ERROR_LOG}")
  fi

  if [[ -n "${TRANSCODER_HTTP2_CA_CERTS:-}" ]]; then
    SERVER_ARGS+=(--ca-certs "${TRANSCODER_HTTP2_CA_CERTS}")
  fi

  case "${TRANSCODER_HTTP2_RELOAD:-}" in
    1|true|TRUE|yes|YES|on|ON)
      SERVER_ARGS+=(--reload)
      ;;
  esac

  SERVER_ARGS+=("http2_asgi:app")
else
  if [[ -x "$ROOT_DIR/venv/bin/gunicorn" ]]; then
    SERVER_CMD=("$ROOT_DIR/venv/bin/gunicorn")
  elif command -v gunicorn >/dev/null 2>&1; then
    SERVER_CMD=("$(command -v gunicorn)")
  else
    SERVER_CMD=("$PYTHON_BIN" "-m" "gunicorn")
  fi

  SERVER_LABEL="gunicorn"
  SERVER_ARGS+=(
    --workers "$GUNICORN_WORKERS"
    --worker-class "$GUNICORN_WORKER_CLASS"
  )

  if [[ -n "${GUNICORN_THREADS:-}" ]]; then
    SERVER_ARGS+=(--threads "$GUNICORN_THREADS")
  fi

  if [[ -z "${GUNICORN_WORKER_CONNECTIONS:-}" && -n "${API_GUNICORN_WORKER_CONNECTIONS:-}" ]]; then
    GUNICORN_WORKER_CONNECTIONS="$API_GUNICORN_WORKER_CONNECTIONS"
  fi

  if [[ -n "${GUNICORN_WORKER_CONNECTIONS:-}" ]]; then
    SERVER_ARGS+=(--worker-connections "${GUNICORN_WORKER_CONNECTIONS}")
  elif [[ "$GUNICORN_WORKER_CLASS" == "eventlet" || "$GUNICORN_WORKER_CLASS" == "gevent" ]]; then
    SUGGESTED_CONNECTIONS=$(( CPU_CORES * 200 ))
    SERVER_ARGS+=(--worker-connections "$SUGGESTED_CONNECTIONS")
  fi

  SERVER_ARGS+=(
    --bind "$FLASK_RUN_HOST:$FLASK_RUN_PORT"
    --chdir "$ROOT_DIR"
    "src.wsgi:app"
  )
fi

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
  DEFAULT_EMBEDDED_CELERY_QUEUES="transcoder,library_sections,library_images"
  CELERY_WORKER_QUEUE_VALUE="${CELERY_WORKER_QUEUE:-$DEFAULT_EMBEDDED_CELERY_QUEUES}"
  CELERY_WORKER_QUEUE="$CELERY_WORKER_QUEUE_VALUE" "$CELERY_LAUNCHER" &
  CELERY_PID=$!
  PROC_PIDS+=("$CELERY_PID")
  PID_LABEL[$CELERY_PID]="celery"
fi

if [[ ${#SERVER_CMD[@]} -eq 0 ]]; then
  echo "No web server command resolved." >&2
  terminate_children TERM
  exit 1
fi

if [[ -z "$SERVER_LABEL" ]]; then
  SERVER_LABEL="server"
fi

"${SERVER_CMD[@]}" "${SERVER_ARGS[@]}" &
SERVER_PID=$!
PROC_PIDS+=("$SERVER_PID")
PID_LABEL[$SERVER_PID]="$SERVER_LABEL"

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
