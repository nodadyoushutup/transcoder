#!/usr/bin/env bash
# Helper functions for service kill scripts. Source this file from bash scripts.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "kill_common.sh must be sourced, not executed." >&2
  exit 1
fi

if [[ ${KILL_COMMON_SH_LOADED:-0} -eq 1 ]]; then
  return
fi
KILL_COMMON_SH_LOADED=1

kill_targets() {
  local signal="$1"
  shift
  local -a ids=("$@")
  (( ${#ids[@]} == 0 )) && return 0

  declare -A seen_ids=()
  local -a unique_ids=()
  for pid in "${ids[@]}"; do
    [[ -z "${pid:-}" ]] && continue
    if [[ -z "${seen_ids[$pid]:-}" ]]; then
      unique_ids+=("$pid")
      seen_ids[$pid]=1
    fi
  done

  (( ${#unique_ids[@]} == 0 )) && return 0

  declare -A seen_groups=()
  local -a group_targets=()
  local pid pgid
  for pid in "${unique_ids[@]}"; do
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [[ -n "${pgid:-}" && -z "${seen_groups[$pgid]:-}" ]]; then
      group_targets+=("-$pgid")
      seen_groups[$pgid]=1
    fi
  done

  if (( ${#group_targets[@]} > 0 )); then
    kill "-$signal" "${group_targets[@]}" 2>/dev/null || true
  fi

  kill "-$signal" "${unique_ids[@]}" 2>/dev/null || true
}

stop_by_pattern() {
  local desc="$1"
  local pattern="$2"
  local -a pids=()
  mapfile -t pids < <(pgrep -f "$pattern" 2>/dev/null || true)

  if (( ${#pids[@]} == 0 )) || [[ -z "${pids[0]:-}" ]]; then
    echo "[skip] $desc: no matching processes"
    return
  fi

  declare -A seen=()
  local -a unique=()
  local pid
  for pid in "${pids[@]}"; do
    [[ -z "${pid:-}" ]] && continue
    if [[ -z "${seen[$pid]:-}" ]]; then
      unique+=("$pid")
      seen[$pid]=1
    fi
  done

  if (( ${#unique[@]} == 0 )); then
    echo "[skip] $desc: no matching processes"
    return
  fi

  echo "[term] $desc (pattern: $pattern) — PIDs ${unique[*]}"
  kill_targets TERM "${unique[@]}"
  sleep 1

  local -a survivors=()
  for pid in "${unique[@]}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      survivors+=("$pid")
    fi
  done

  if (( ${#survivors[@]} == 0 )); then
    echo "[done] $desc stopped"
    return
  fi

  echo "[kill] $desc stubborn PIDs ${survivors[*]}"
  kill_targets KILL "${survivors[@]}"
}

stop_by_port() {
  local desc="$1"
  local port="$2"
  local -a pids=()

  if command -v lsof >/dev/null 2>&1; then
    mapfile -t pids < <(lsof -ti tcp:"$port" 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    mapfile -t pids < <(fuser -v "$port"/tcp 2>/dev/null | awk '{for (i = 1; i <= NF; ++i) if ($i ~ /^[0-9]+$/) print $i}' || true)
  else
    echo "[warn] $desc on port $port: unable to inspect (install lsof or fuser)"
    return
  fi

  declare -A seen=()
  local -a unique=()
  local pid
  for pid in "${pids[@]}"; do
    [[ -z "${pid:-}" ]] && continue
    if [[ -z "${seen[$pid]:-}" ]]; then
      unique+=("$pid")
      seen[$pid]=1
    fi
  done

  if (( ${#unique[@]} == 0 )); then
    echo "[skip] $desc on port $port: no listeners"
    return
  fi

  echo "[term] $desc on port $port — PIDs ${unique[*]}"
  kill_targets TERM "${unique[@]}"
  sleep 1

  local -a survivors=()
  for pid in "${unique[@]}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      survivors+=("$pid")
    fi
  done

  if (( ${#survivors[@]} == 0 )); then
    echo "[done] $desc on port $port released"
    return
  fi

  echo "[kill] $desc on port $port stubborn PIDs ${survivors[*]}"
  kill_targets KILL "${survivors[@]}"
}

kill_patterns() {
  local -n patterns_ref=$1
  local desc
  for desc in "${!patterns_ref[@]}"; do
    stop_by_pattern "$desc" "${patterns_ref[$desc]}"
  done
}

release_ports() {
  local -n ports_ref=$1
  local entry desc port
  for entry in "${ports_ref[@]}"; do
    desc=${entry%%|*}
    port=${entry##*|}
    stop_by_port "$desc" "$port"
  done
}
