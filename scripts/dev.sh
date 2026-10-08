#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
fi

# Ensure deterministic Compose provider is selected
export PODMAN_COMPOSE_PROVIDER=podman-compose

_fail() {
  echo "$1" >&2
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return 1 2>/dev/null || exit 1
  else
    exit 1
  fi
}

# 1. Verify podman is available
if ! command -v podman >/dev/null 2>&1; then
  _fail "ERROR: podman is not installed or not in PATH"
  return 1 2>/dev/null || exit 1
fi

# 2. Verify podman-compose is available
if ! command -v podman-compose >/dev/null 2>&1; then
  _fail "ERROR: podman-compose is not installed or not in PATH"
  return 1 2>/dev/null || exit 1
fi

# 3. Verify podman compose provider preflight resolves to podman-compose 1.6.0
VERSION_OUTPUT=$(podman compose version 2>&1) || {
  _fail "ERROR: Failed to query podman compose version: ${VERSION_OUTPUT}"
  return 1 2>/dev/null || exit 1
}

if ! echo "${VERSION_OUTPUT}" | grep -q "podman-compose version 1.6.0"; then
  _fail "ERROR: Requires podman-compose 1.6.0"
  return 1 2>/dev/null || exit 1
fi

echo "Compose provider preflight verified: podman-compose 1.6.0 (PODMAN_COMPOSE_PROVIDER=${PODMAN_COMPOSE_PROVIDER})"
