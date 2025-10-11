#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)

# shellcheck disable=SC1090
source "$PROJECT_ROOT/kill_common.sh"

declare -A PROCESS_PATTERNS=(
  ["API service (Gunicorn)"]=--chdir\ ${PROJECT_ROOT}/core/api
  ["Celery processes"]=core.api.src.celery.worker:celery
)

PORT_TARGETS=(
  "API HTTP port|5001"
)

echo "== Killing API stack =="
kill_patterns PROCESS_PATTERNS
release_ports PORT_TARGETS

echo "== API stack cleanup complete =="
