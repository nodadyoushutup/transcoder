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

LOG_DIR="${TRANSCODER_API_LOG_DIR:-${TRANSCODER_BACKEND_LOG_DIR:-$ROOT_DIR/logs}}"
mkdir -p "$LOG_DIR"

CELERY_LOGLEVEL="${CELERY_LOG_LEVEL:-info}"
SCHEDULE_FILE="${CELERY_BEAT_SCHEDULE_FILE:-$LOG_DIR/celery-beat-schedule.db}"

exec "${CELERY_CMD[@]}" \
  -A core.api.src.celery_app.worker:celery \
  beat \
  --loglevel "$CELERY_LOGLEVEL" \
  --schedule "$SCHEDULE_FILE"
