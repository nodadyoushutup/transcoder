#!/usr/bin/env bash
# shellcheck shell=bash
# Load the nearest .env file relative to the caller so microservices share a common configuration.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "load-dotenv.sh must be sourced, not executed." >&2
  exit 1
fi

if [[ "${TRANSCODER_DOTENV_LOADED:-0}" == "1" ]]; then
  return 0
fi

search_start="${1:-$PWD}"
current_dir="$search_start"
dotenv_file=""

while [[ "$current_dir" != "/" ]]; do
  if [[ -f "$current_dir/.env" ]]; then
    dotenv_file="$current_dir/.env"
    break
  fi
  current_dir="$(dirname "$current_dir")"
done

if [[ -z "$dotenv_file" ]]; then
  export TRANSCODER_DOTENV_PATH=""
  export TRANSCODER_DOTENV_LOADED=1
  return 0
fi

if [[ "${TRANSCODER_DOTENV_VERBOSE:-0}" == "1" ]]; then
  echo "Loading environment from $dotenv_file" >&2
fi

set -a
# shellcheck disable=SC1090
source "$dotenv_file"
set +a

export TRANSCODER_DOTENV_PATH="$dotenv_file"
export TRANSCODER_DOTENV_LOADED=1
