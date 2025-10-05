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

exec "${GUNICORN_CMD[@]}" \
  --workers "$GUNICORN_WORKERS" \
  --worker-class "$GUNICORN_WORKER_CLASS" \
  --bind "$FLASK_RUN_HOST:$FLASK_RUN_PORT" \
  --chdir "$ROOT_DIR" \
  "src.wsgi:app"
