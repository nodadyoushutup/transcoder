#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_CELERY="$ROOT_DIR/venv/bin/celery"
PYTHON_BIN="python3"

if [[ -x "$VENV_CELERY" ]]; then
  CELERY_CMD=("$VENV_CELERY")
elif command -v celery >/dev/null 2>&1; then
  CELERY_CMD=("$(command -v celery)")
else
  CELERY_CMD=("$PYTHON_BIN" "-m" "celery")
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

CELERY_QUEUE="${CELERY_QUEUE:-${1:-transcode_av}}"
if [[ "$CELERY_QUEUE" == "${CELERY_TRANSCODE_AV_QUEUE:-transcode_av}" ]]; then
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-${CELERY_TRANSCODE_AV_CONCURRENCY:-1}}"
elif [[ "$CELERY_QUEUE" == "${CELERY_TRANSCODE_SUBTITLE_QUEUE:-transcode_subtitles}" ]]; then
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-${CELERY_TRANSCODE_SUBTITLE_CONCURRENCY:-2}}"
else
  CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-1}"
fi
CELERY_LOGLEVEL="${CELERY_LOG_LEVEL:-info}"

# Generate a unique hostname per worker unless caller overrides CELERY_WORKER_NAME.
HOST_BASENAME=${CELERY_WORKER_HOST_BASENAME:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "local")}
UNIQUE_SUFFIX=${CELERY_WORKER_SUFFIX:-$$_$(date +%s)}
DEFAULT_IDENTIFIER="${CELERY_WORKER_PREFIX:-transcoder}-${CELERY_QUEUE}-${UNIQUE_SUFFIX}"
CELERY_WORKER_NAME="${CELERY_WORKER_NAME:-${DEFAULT_IDENTIFIER}@${HOST_BASENAME}}"

exec "${CELERY_CMD[@]}" \
  -A core.transcoder.src.celery_worker_app:celery \
  worker \
  -Q "$CELERY_QUEUE" \
  --concurrency "$CELERY_CONCURRENCY" \
  --loglevel "$CELERY_LOGLEVEL" \
  --hostname "$CELERY_WORKER_NAME"
