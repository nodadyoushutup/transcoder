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

set +e
set +o pipefail
PYTHONPATH="$ROOT_DIR/src:${PYTHONPATH:-}" timeout --signal=INT --kill-after=5 20 "$PYTHON_BIN" "$ROOT_DIR/run.py" | tee "$LOG_FILE"
STATUS=${PIPESTATUS[0]:-0}
set -o pipefail
set -e

exit "$STATUS"
