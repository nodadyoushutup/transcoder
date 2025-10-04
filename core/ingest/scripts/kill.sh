#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)

# shellcheck disable=SC1090
source "$PROJECT_ROOT/kill_common.sh"

declare -A PROCESS_PATTERNS=(
  ["Ingest service (Gunicorn)"]=--chdir\ ${PROJECT_ROOT}/core/ingest
)

PORT_TARGETS=(
  "Ingest HTTP port|5005"
)

echo "== Killing ingest service =="
kill_patterns PROCESS_PATTERNS
release_ports PORT_TARGETS

echo "== Ingest service cleanup complete =="
