#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_BIN="$ROOT_DIR/venv/bin/celery"
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
SCHEDULE_FILE="${CELERY_BEAT_SCHEDULE_FILE:-$LOG_DIR/celery-beat-schedule.db}"

exec "$CELERY_BIN" \
  --app core.api.src.celery_app:celery_app \
  beat \
  --loglevel "$LOG_LEVEL" \
  --schedule "$SCHEDULE_FILE"
