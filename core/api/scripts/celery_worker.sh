#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_ROOT=$(cd "$ROOT_DIR/../.." && pwd)
VENV_CELERY="$ROOT_DIR/venv/bin/celery"
PROJECT_VENV_CELERY="$REPO_ROOT/venv/bin/celery"
PYTHON_BIN="python3"

if [[ -x "$VENV_CELERY" ]]; then
  CELERY_CMD=("$VENV_CELERY")
elif [[ -x "$PROJECT_VENV_CELERY" ]]; then
  CELERY_CMD=("$PROJECT_VENV_CELERY")
elif command -v celery >/dev/null 2>&1; then
  CELERY_CMD=("$(command -v celery)")
else
  CELERY_CMD=("$PYTHON_BIN" "-m" "celery")
fi

if [[ -z "${TRANSCODER_SKIP_DOTENV:-}" ]]; then
  DOTENV_HELPER="$REPO_ROOT/load-dotenv.sh"
  if [[ -f "$DOTENV_HELPER" ]]; then
    # shellcheck disable=SC1091
    source "$DOTENV_HELPER" "$ROOT_DIR"
  fi
fi

PYTHONPATH_ENTRIES="$REPO_ROOT"
if [[ -n "${PYTHONPATH:-}" ]]; then
  export PYTHONPATH="${PYTHONPATH}:${PYTHONPATH_ENTRIES}"
else
  export PYTHONPATH="${PYTHONPATH_ENTRIES}"
fi

DEFAULT_QUEUE="${CELERY_DEFAULT_QUEUE:-transcoder}"
LIBRARY_QUEUE="${CELERY_LIBRARY_QUEUE:-library_sections}"
IMAGE_QUEUE="${CELERY_IMAGE_CACHE_QUEUE:-library_images}"

CELERY_QUEUE="${CELERY_QUEUE:-${1:-$DEFAULT_QUEUE}}"
CELERY_LOGLEVEL="${CELERY_LOG_LEVEL:-info}"

if [[ "$CELERY_QUEUE" == "$LIBRARY_QUEUE" ]]; then
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-${CELERY_LIBRARY_CONCURRENCY:-4}}"
elif [[ "$CELERY_QUEUE" == "$IMAGE_QUEUE" ]]; then
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-${CELERY_IMAGE_CONCURRENCY:-4}}"
elif [[ "$CELERY_QUEUE" == "$DEFAULT_QUEUE" ]]; then
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-${CELERY_DEFAULT_CONCURRENCY:-4}}"
else
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-4}"
fi

HOST_BASENAME=${CELERY_WORKER_HOST_BASENAME:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "local")}
UNIQUE_SUFFIX=${CELERY_WORKER_SUFFIX:-$$_$(date +%s)}
DEFAULT_IDENTIFIER="${CELERY_WORKER_PREFIX:-api}-${CELERY_QUEUE}-${UNIQUE_SUFFIX}"
CELERY_WORKER_NAME="${CELERY_WORKER_NAME:-${DEFAULT_IDENTIFIER}@${HOST_BASENAME}}"

exec "${CELERY_CMD[@]}" \
  -A core.api.src.celery_app.worker:celery \
  worker \
  -Q "$CELERY_QUEUE" \
  --concurrency "$CELERY_CONCURRENCY" \
  --loglevel "$CELERY_LOGLEVEL" \
  --hostname "$CELERY_WORKER_NAME"
