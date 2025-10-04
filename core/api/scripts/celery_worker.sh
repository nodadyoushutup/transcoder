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

REPO_ROOT=$(cd "$ROOT_DIR/../.." && pwd)
if [[ -z "${TRANSCODER_SKIP_DOTENV:-}" ]]; then
  DOTENV_HELPER="$REPO_ROOT/load-dotenv.sh"
  if [[ -f "$DOTENV_HELPER" ]]; then
    # shellcheck disable=SC1091
    source "$DOTENV_HELPER" "$ROOT_DIR"
  fi
fi

export PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:${PYTHONPATH:-}"

LOG_DIR="${TRANSCODER_API_LOG_DIR:-${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}}"
mkdir -p "$LOG_DIR"

LOG_LEVEL="${CELERY_LOG_LEVEL:-info}"
WORKER_QUEUE="${CELERY_WORKER_QUEUE:-transcoder,library_sections,library_images}"
LIBRARY_QUEUE="${CELERY_LIBRARY_QUEUE:-library_sections}"
IMAGE_QUEUE="${CELERY_IMAGE_CACHE_QUEUE:-library_images}"
WORKER_CONCURRENCY="${CELERY_WORKER_CONCURRENCY:-}"

# Ensure the image cache queue is always included so artwork tasks are serviced.
if [[ ",$WORKER_QUEUE," != *",$IMAGE_QUEUE,"* ]]; then
  if [[ -n "$WORKER_QUEUE" ]]; then
    WORKER_QUEUE="$WORKER_QUEUE,$IMAGE_QUEUE"
  else
    WORKER_QUEUE="$IMAGE_QUEUE"
  fi
fi

if [[ -z "$WORKER_CONCURRENCY" ]]; then
  case ",$WORKER_QUEUE," in
    *,"$LIBRARY_QUEUE",*|*,"$IMAGE_QUEUE",*)
      WORKER_CONCURRENCY=4
      ;;
  esac
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
