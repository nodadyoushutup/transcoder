#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANUAL_SCRIPT="$ROOT_DIR/test/manual_encode.sh"
LOG_DIR="$ROOT_DIR/logs"
OUT_DIR="$ROOT_DIR/../out"

if [[ ! -f "$MANUAL_SCRIPT" ]]; then
  echo "Missing manual encode script at $MANUAL_SCRIPT" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$OUT_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/agent-${TIMESTAMP}.log"

pushd "$ROOT_DIR" >/dev/null
set +e
set +o pipefail
timeout --signal=INT --kill-after=5 20 bash "$MANUAL_SCRIPT" 2>&1 | tee "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -o pipefail
set -e
popd >/dev/null

exit "$EXIT_CODE"
