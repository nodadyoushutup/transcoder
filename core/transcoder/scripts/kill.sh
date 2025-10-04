#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)

# shellcheck disable=SC1090
source "$PROJECT_ROOT/kill_common.sh"

declare -A PROCESS_PATTERNS=(
  ["Transcoder service (Gunicorn)"]=--chdir\ ${PROJECT_ROOT}/core/transcoder
)

PORT_TARGETS=(
  "Transcoder HTTP port|5003"
)

echo "== Killing transcoder service =="
kill_patterns PROCESS_PATTERNS
release_ports PORT_TARGETS

echo "== Transcoder service cleanup complete =="
