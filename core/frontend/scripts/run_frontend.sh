#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FRONTEND_DIR="$ROOT_DIR"
PORT="${FRONTEND_PORT:-5173}"
HOST="${FRONTEND_HOST:-0.0.0.0}"
LOG_DIR="${FRONTEND_LOG_DIR:-$ROOT_DIR/logs}"

if [[ ! -f "$FRONTEND_DIR/package.json" ]]; then
  echo "Frontend workspace missing at $FRONTEND_DIR" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to run the frontend development server" >&2
  exit 1
fi

cd "$FRONTEND_DIR"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/dev-$(date +%Y%m%d-%H%M%S).log"

if [[ ! -d node_modules ]]; then
  npm install
fi

set +e
set -o pipefail
npm run dev -- --host "$HOST" --port "$PORT" 2>&1 | tee "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
exit "$EXIT_CODE"
