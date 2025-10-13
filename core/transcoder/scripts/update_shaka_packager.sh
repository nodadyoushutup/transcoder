#!/usr/bin/env bash
set -euo pipefail

# This script removes the currently installed Shaka Packager binary and
# installs the latest release published on GitHub for the current platform.
# It requires curl, tar, and (for installation into /usr/local/bin) sudo.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}"/shaka-upgrade.XXXXXX)"
INSTALL_PREFIX="/usr/local/bin"

PLATFORM="linux-x64"

cleanup() {
  if [[ -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

VERSION="${SHAKA_VERSION:-latest}"
if [[ "${VERSION}" == "latest" ]]; then
  BASE_URL="https://github.com/shaka-project/shaka-packager/releases/latest/download"
else
  # ensure the tag is prefixed with v
  STRIPPED="${VERSION#v}"
  BASE_URL="https://github.com/shaka-project/shaka-packager/releases/download/v${STRIPPED}"
fi

BINARY_NAME="packager-${PLATFORM}"

echo "Preparing to download Shaka Packager (${VERSION})…"
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not available. Aborting." >&2
  exit 1
fi

DOWNLOAD_URL="${SHAKA_PACKAGER_URL:-${BASE_URL}/${BINARY_NAME}}"
ARCHIVE_PATH="${WORK_DIR}/${BINARY_NAME}"

echo "Downloading ${DOWNLOAD_URL}…"
if ! curl -fL "${DOWNLOAD_URL}" -o "${ARCHIVE_PATH}"; then
  echo "Failed to download Shaka Packager from ${DOWNLOAD_URL}" >&2
  exit 1
fi

if [[ ! -s "${ARCHIVE_PATH}" ]]; then
  echo "Downloaded file is empty; aborting." >&2
  exit 1
fi

echo "Removing existing packager binary (if present)…"
if command -v packager >/dev/null 2>&1; then
  EXISTING_PATH="$(command -v packager)"
  if [[ -w "${EXISTING_PATH}" ]]; then
    rm -f "${EXISTING_PATH}"
  else
    echo "Existing packager located at ${EXISTING_PATH} requires elevated privileges to remove."
    sudo rm -f "${EXISTING_PATH}"
  fi
fi

chmod +x "${ARCHIVE_PATH}"
NEW_BINARY="${ARCHIVE_PATH}"

echo "Installing new packager binary into ${INSTALL_PREFIX}…"
if [[ -w "${INSTALL_PREFIX}" ]]; then
  install -m 0755 "${NEW_BINARY}" "${INSTALL_PREFIX}/packager"
else
  sudo install -m 0755 "${NEW_BINARY}" "${INSTALL_PREFIX}/packager"
fi

echo "Shaka Packager upgraded successfully:"
packager --version
