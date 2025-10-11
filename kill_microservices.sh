#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

SERVICES=(
  api
  transcoder
  gui
  ingest
)

declare -A SCRIPT_MAP=(
  [api]="$PROJECT_ROOT/core/api/scripts/kill.sh"
  [transcoder]="$PROJECT_ROOT/core/transcoder/scripts/kill.sh"
  [gui]="$PROJECT_ROOT/core/gui/scripts/kill.sh"
  [ingest]="$PROJECT_ROOT/core/ingest/scripts/kill.sh"
)

usage() {
  cat <<USAGE
Usage: ${0##*/} [service...]

Without arguments, executes every service-specific kill script. Supply one or
more service names (${SERVICES[*]}) to only stop those targets.
USAGE
}

run_kill_script() {
  local service="$1"
  local script="${SCRIPT_MAP[$service]:-}"

  if [[ -z "$script" ]]; then
    echo "[warn] Unknown service '$service'" >&2
    return 1
  fi

  if [[ ! -x "$script" ]]; then
    if [[ -f "$script" ]]; then
      echo "[warn] $service kill script exists but is not executable: $script" >&2
    else
      echo "[warn] $service kill script missing at $script" >&2
    fi
    return 1
  fi

  echo "== Killing $service service =="
  "$script"
}

main() {
  local -a targets=()
  if (( $# == 0 )); then
    targets=("${SERVICES[@]}")
  else
    case "$1" in
      -h|--help)
        usage
        return 0
        ;;
    esac
    targets=("$@")
  fi

  local service
  local exit_code=0
  for service in "${targets[@]}"; do
    if ! run_kill_script "$service"; then
      exit_code=1
    fi
  done

  exit "$exit_code"
}

main "$@"
