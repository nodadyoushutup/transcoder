#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)

# shellcheck disable=SC1090
source "$PROJECT_ROOT/kill_common.sh"

declare -A PROCESS_PATTERNS=(
  ["Frontend dev server (npm)"]=npm\ run\ dev\ --\ --host
  ["Frontend dev server (vite)"]=--port\ 5173
)

PORT_TARGETS=(
  "Frontend dev server|5173"
)

echo "== Killing frontend dev server =="
kill_patterns PROCESS_PATTERNS
release_ports PORT_TARGETS

echo "== Frontend dev server cleanup complete =="
