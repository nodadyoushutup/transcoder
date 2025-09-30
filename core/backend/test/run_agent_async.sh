#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VENV_PY="$ROOT_DIR/venv/bin/python"
PYTHON_BIN="python3"

if [[ -x "$VENV_PY" ]]; then
  PYTHON_BIN="$VENV_PY"
fi

LOG_DIR="$ROOT_DIR/logs"
OUT_DIR="$ROOT_DIR/out"

mkdir -p "$LOG_DIR"
rm -rf "$OUT_DIR" || true
mkdir -p "$OUT_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/run-${TIMESTAMP}.log"
ENCODE_DURATION=${ENCODE_DURATION:-30}
PORT=${PORT:-8080}
PIDS_FILE="$LOG_DIR/agent_processes-${TIMESTAMP}.pid"

cd "$ROOT_DIR"

(
  PYTHONPATH="$ROOT_DIR/src:${PYTHONPATH:-}" timeout --signal=INT --kill-after=5 "$ENCODE_DURATION" "$PYTHON_BIN" run.py 2>&1 | tee "$LOG_FILE"
) &
ENCODE_PID=$!

echo "$ENCODE_PID" > "$PIDS_FILE"

echo "Started encoder (PID $ENCODE_PID) with log $LOG_FILE"

echo "Waiting 10 seconds before launching web server on port $PORT..."
sleep 10

(
  "$PYTHON_BIN" -m http.server "$PORT"
) &
SERVER_PID=$!

echo "$SERVER_PID" >> "$PIDS_FILE"

echo "Started web server (PID $SERVER_PID)."

echo "Processes recorded in $PIDS_FILE"

echo "Use 'kill \$(tr '\n' ' ' < "$PIDS_FILE")' to stop both processes manually when finished."

echo "Script exiting while background jobs continue running."
exit 0
