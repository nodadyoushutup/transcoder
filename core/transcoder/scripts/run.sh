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

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:$ROOT_DIR/../api/src:${PYTHONPATH:-}"
export FLASK_RUN_HOST="${FLASK_RUN_HOST:-${TRANSCODER_TRANSCODER_HOST:-0.0.0.0}}"
export FLASK_RUN_PORT="${FLASK_RUN_PORT:-${TRANSCODER_TRANSCODER_PORT:-5003}}"

export TRANSCODER_SERVICE_LOG_DIR="${TRANSCODER_SERVICE_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$TRANSCODER_SERVICE_LOG_DIR"

media_root="${TRANSCODER_OUTPUT:-${TRANSCODER_SHARED_OUTPUT_DIR:-$HOME/transcode_data}}"
if [[ -n "$media_root" ]]; then
  mkdir -p "$media_root"
fi

if [[ -z "${GUNICORN_WORKERS:-}" && -n "${TRANSCODER_GUNICORN_WORKERS:-}" ]]; then
  GUNICORN_WORKERS="$TRANSCODER_GUNICORN_WORKERS"
fi

DEFAULT_WORKERS="${WEB_CONCURRENCY:-1}"
GUNICORN_WORKERS="${GUNICORN_WORKERS:-$DEFAULT_WORKERS}"
if [[ -z "$GUNICORN_WORKERS" ]]; then
  GUNICORN_WORKERS=1
fi
if [[ "$GUNICORN_WORKERS" != "1" ]]; then
  cat >&2 <<EOF
Warning: Transcoder service requires a single worker. Overriding requested worker count (${GUNICORN_WORKERS}) to 1.
EOF
  GUNICORN_WORKERS=1
fi
export TRANSCODER_WORKER_PROCESSES="$GUNICORN_WORKERS"
if [[ -z "${GUNICORN_WORKER_CLASS:-}" && -n "${TRANSCODER_GUNICORN_WORKER_CLASS:-}" ]]; then
  GUNICORN_WORKER_CLASS="$TRANSCODER_GUNICORN_WORKER_CLASS"
fi
GUNICORN_WORKER_CLASS="${GUNICORN_WORKER_CLASS:-sync}"

if [[ -x "$ROOT_DIR/venv/bin/gunicorn" ]]; then
  GUNICORN_CMD=("$ROOT_DIR/venv/bin/gunicorn")
elif command -v gunicorn >/dev/null 2>&1; then
  GUNICORN_CMD=("$(command -v gunicorn)")
else
  GUNICORN_CMD=("$PYTHON_BIN" "-m" "gunicorn")
fi

DEFAULT_TIMEOUT="${TRANSCODER_GUNICORN_TIMEOUT:-300}"
GUNICORN_TIMEOUT="${GUNICORN_TIMEOUT:-$DEFAULT_TIMEOUT}"
if [[ -z "$GUNICORN_TIMEOUT" ]]; then
  GUNICORN_TIMEOUT=300
fi

SERVER_CMD=("${GUNICORN_CMD[@]}")
SERVER_ARGS=(
  --workers "$GUNICORN_WORKERS"
  --worker-class "$GUNICORN_WORKER_CLASS"
  --timeout "$GUNICORN_TIMEOUT"
  --bind "$FLASK_RUN_HOST:$FLASK_RUN_PORT"
  --chdir "$ROOT_DIR"
  "src.wsgi:app"
)

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
  WORKER_LAUNCHER="$ROOT_DIR/scripts/worker.sh"
  if [[ ! -x "$WORKER_LAUNCHER" ]]; then
    echo "Celery worker helper $WORKER_LAUNCHER not found or not executable." >&2
    exit 1
  fi

  DEFAULT_AV_QUEUE="${CELERY_TRANSCODE_AV_QUEUE:-transcode_av}"
  DEFAULT_SUB_QUEUE="${CELERY_TRANSCODE_SUBTITLE_QUEUE:-transcode_subtitles}"
  DEFAULT_QUEUE_SET="$DEFAULT_AV_QUEUE,$DEFAULT_SUB_QUEUE"
  QUEUE_LIST="${TRANSCODER_CELERY_WORKER_QUEUES:-$DEFAULT_QUEUE_SET}"

  IFS=',' read -r -a RAW_QUEUES <<< "$QUEUE_LIST"
  declare -A SEEN_QUEUE=()
  HOST_BASENAME=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "local")
  worker_index=0
  for raw_queue in "${RAW_QUEUES[@]}"; do
    queue=$(printf '%s' "$raw_queue" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [[ -z "$queue" ]]; then
      continue
    fi
    if [[ -n "${SEEN_QUEUE[$queue]:-}" ]]; then
      continue
    fi
    SEEN_QUEUE[$queue]=1
    worker_index=$((worker_index + 1))
    worker_identifier="transcoder-${queue}-${worker_index}-$$"
    CELERY_QUEUE="$queue" \
    CELERY_WORKER_NAME="${worker_identifier}@${HOST_BASENAME}" \
      "$WORKER_LAUNCHER" &
    worker_pid=$!
    PROC_PIDS+=("$worker_pid")
    PID_LABEL[$worker_pid]="celery[$queue]"
  done

  if [[ ${#PROC_PIDS[@]} -eq 0 ]]; then
    echo "No Celery queues resolved from $QUEUE_LIST; refusing to start." >&2
    exit 1
  fi
fi

"${SERVER_CMD[@]}" "${SERVER_ARGS[@]}" &
SERVER_PID=$!
PROC_PIDS+=("$SERVER_PID")
PID_LABEL[$SERVER_PID]="gunicorn"

ACTIVE_PIDS=("${PROC_PIDS[@]}")
EXIT_CODE=0
FINISHED_PID=""
FINISHED_LABEL=""

while ((${#ACTIVE_PIDS[@]})); do
  wait -n "${ACTIVE_PIDS[@]}"
  status=$?
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
    FINISHED_LABEL=${PID_LABEL[$FINISHED_PID]:-process}
    break
  fi
done

if [[ ${EXIT_CODE} -ne 0 ]]; then
  echo "${FINISHED_LABEL^} exited with status ${EXIT_CODE}. Shutting down remaining services." >&2
fi

terminate_children TERM
for pid in "${PROC_PIDS[@]}"; do
  if [[ -n "${pid:-}" ]]; then
    wait "$pid" 2>/dev/null || true
  fi
done

exit "$EXIT_CODE"
