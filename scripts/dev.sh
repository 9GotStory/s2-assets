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
fi

# 2. Verify podman-compose is available
if ! command -v podman-compose >/dev/null 2>&1; then
  _fail "ERROR: podman-compose is not installed or not in PATH"
fi

# 3. Verify podman compose provider preflight resolves to podman-compose 1.6.0
VERSION_OUTPUT=$(podman compose version 2>&1) || {
  _fail "ERROR: Failed to query podman compose version: ${VERSION_OUTPUT}"
}

CLEAN_VERSION_OUTPUT=$(echo "${VERSION_OUTPUT}" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g')

if ! echo "${CLEAN_VERSION_OUTPUT}" | grep -Eq "^podman-compose version 1\.6\.0[[:space:]]*$"; then
  _fail "ERROR: Requires podman-compose 1.6.0"
fi

echo "Compose provider preflight verified: podman-compose 1.6.0 (PODMAN_COMPOSE_PROVIDER=${PODMAN_COMPOSE_PROVIDER})"

# If invoked without arguments or sourced without parameters, preflight is complete.
if [ $# -eq 0 ]; then
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return 0 2>/dev/null || exit 0
  else
    exit 0
  fi
fi

ACTION="$1"
shift

case "$ACTION" in
  prepare)
    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
    COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

    if [ ! -f "$COMPOSE_FILE" ]; then
      _fail "ERROR: Compose file not found at ${COMPOSE_FILE}"
    fi

    # Validate FOUNDATION_ENV_FILE is set
    if [ -z "${FOUNDATION_ENV_FILE:-}" ]; then
      _fail "ERROR: FOUNDATION_ENV_FILE is not set. Specify the path to a trusted private environment file."
    fi

    # Validate absolute path
    case "$FOUNDATION_ENV_FILE" in
      /*) ;;
      *) _fail "ERROR: FOUNDATION_ENV_FILE must be an absolute path: ${FOUNDATION_ENV_FILE}" ;;
    esac

    # Validate file existence
    if [ ! -f "$FOUNDATION_ENV_FILE" ]; then
      _fail "ERROR: FOUNDATION_ENV_FILE not found: ${FOUNDATION_ENV_FILE}"
    fi

    # Validate path is outside repository checkout
    case "$FOUNDATION_ENV_FILE" in
      "${REPO_ROOT}"/*)
        _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
        ;;
    esac

    # Validate file permissions (must not be group/other accessible)
    FILE_MODE=$(stat -c "%a" "$FOUNDATION_ENV_FILE" 2>/dev/null || stat -f "%OLp" "$FOUNDATION_ENV_FILE" 2>/dev/null || true)
    if [ -n "$FILE_MODE" ]; then
      FILE_TAIL="${FILE_MODE: -2}"
      if [ "$FILE_TAIL" != "00" ]; then
        _fail "ERROR: Insecure permissions on ${FOUNDATION_ENV_FILE}: mode must be 600 or 400 (got ${FILE_MODE})"
      fi
    fi

    # Validate directory permissions (must not be group/other accessible)
    ENV_DIR=$(dirname "$FOUNDATION_ENV_FILE")
    DIR_MODE=$(stat -c "%a" "$ENV_DIR" 2>/dev/null || stat -f "%OLp" "$ENV_DIR" 2>/dev/null || true)
    if [ -n "$DIR_MODE" ]; then
      DIR_TAIL="${DIR_MODE: -2}"
      if [ "$DIR_TAIL" != "00" ]; then
        _fail "ERROR: Insecure permissions on directory ${ENV_DIR}: mode must be 700 (got ${DIR_MODE})"
      fi
    fi

    # Source the private environment file
    set -a
    # shellcheck disable=SC1090
    source "$FOUNDATION_ENV_FILE"
    set +a

    # Validate required keys and constraints without secret leakage
    if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
      _fail "ERROR: COMPOSE_PROJECT_NAME is required in ${FOUNDATION_ENV_FILE}"
    fi
    if ! echo "$COMPOSE_PROJECT_NAME" | grep -Eq '^[a-z0-9_-]+$'; then
      _fail "ERROR: COMPOSE_PROJECT_NAME must be lowercase alphanumeric with hyphens or underscores"
    fi
    if [ "$COMPOSE_PROJECT_NAME" = "s2-assets" ] || [ "$COMPOSE_PROJECT_NAME" = "default" ]; then
      _fail "ERROR: COMPOSE_PROJECT_NAME must be a unique project name, not shared default"
    fi

    if [ -z "${POSTGRES_DB:-}" ]; then
      _fail "ERROR: POSTGRES_DB is required in ${FOUNDATION_ENV_FILE}"
    fi
    case "$POSTGRES_DB" in
      s2_foundation_?*) ;;
      *) _fail "ERROR: POSTGRES_DB must begin with 's2_foundation_' and specify a dedicated database name" ;;
    esac
    if [ "$POSTGRES_DB" = "s2_foundation_s2_assets" ] || [ "$POSTGRES_DB" = "s2_assets" ]; then
      _fail "ERROR: POSTGRES_DB cannot use repository default names"
    fi

    if [ -z "${POSTGRES_USER:-}" ]; then
      _fail "ERROR: POSTGRES_USER is required in ${FOUNDATION_ENV_FILE}"
    fi
    if [ "$POSTGRES_USER" = "s2_user" ] || [ "$POSTGRES_USER" = "postgres" ] || [ "$POSTGRES_USER" = "admin" ] || [ "$POSTGRES_USER" = "root" ]; then
      _fail "ERROR: POSTGRES_USER cannot use default or privileged usernames"
    fi

    if [ -z "${POSTGRES_PASSWORD:-}" ]; then
      _fail "ERROR: POSTGRES_PASSWORD is required in ${FOUNDATION_ENV_FILE}"
    fi
    if [ "$POSTGRES_PASSWORD" = "s2_password" ] || [ "$POSTGRES_PASSWORD" = "password" ] || [ "$POSTGRES_PASSWORD" = "postgres" ] || [ "$POSTGRES_PASSWORD" = "admin" ] || [ ${#POSTGRES_PASSWORD} -lt 16 ]; then
      _fail "ERROR: POSTGRES_PASSWORD cannot use default or insecure passwords (must be at least 16 characters)"
    fi

    if [ -z "${COOKIE_SECRET:-}" ]; then
      _fail "ERROR: COOKIE_SECRET is required in ${FOUNDATION_ENV_FILE}"
    fi
    if [ "$COOKIE_SECRET" = "secret" ] || [ "$COOKIE_SECRET" = "cookie_secret" ] || [ ${#COOKIE_SECRET} -lt 32 ]; then
      _fail "ERROR: COOKIE_SECRET must be at least 32 bytes and cannot use default secrets"
    fi

    if [ -z "${FOUNDATION_TEST_RUN_ID:-}" ]; then
      _fail "ERROR: FOUNDATION_TEST_RUN_ID is required in ${FOUNDATION_ENV_FILE}"
    fi

    if [ -z "${FOUNDATION_TEST_USERNAME:-}" ]; then
      _fail "ERROR: FOUNDATION_TEST_USERNAME is required in ${FOUNDATION_ENV_FILE}"
    fi

    if [ -z "${FOUNDATION_TEST_PASSWORD:-}" ]; then
      _fail "ERROR: FOUNDATION_TEST_PASSWORD is required in ${FOUNDATION_ENV_FILE}"
    fi
    if [ "$FOUNDATION_TEST_PASSWORD" = "password" ] || [ "$FOUNDATION_TEST_PASSWORD" = "test" ] || [ ${#FOUNDATION_TEST_PASSWORD} -lt 8 ]; then
      _fail "ERROR: FOUNDATION_TEST_PASSWORD cannot use default or trivial passwords"
    fi

    echo "Building development container tooling image..."
    podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" build

    echo "Installing dependencies via frozen lockfile..."
    LOCK_HASH_BEFORE=$(sha256sum "${REPO_ROOT}/pnpm-lock.yaml" | awk '{print $1}')
    podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" run --rm --no-deps api pnpm install --frozen-lockfile
    LOCK_HASH_AFTER=$(sha256sum "${REPO_ROOT}/pnpm-lock.yaml" | awk '{print $1}')

    if [ "$LOCK_HASH_BEFORE" != "$LOCK_HASH_AFTER" ]; then
      _fail "ERROR: pnpm install altered pnpm-lock.yaml; frozen lockfile integrity violated"
    fi

    echo "Verifying container tool versions..."
    CONTAINER_NODE=$(podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" run --rm --no-deps api node -v 2>/dev/null | tr -d '\r')
    if [ "$CONTAINER_NODE" != "v24.21.0" ]; then
      _fail "ERROR: Node version mismatch: expected v24.21.0, got ${CONTAINER_NODE}"
    fi

    CONTAINER_PNPM=$(podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" run --rm --no-deps api pnpm -v 2>/dev/null | tr -d '\r')
    if [ "$CONTAINER_PNPM" != "12.9.1" ]; then
      _fail "ERROR: pnpm version mismatch: expected 12.9.1, got ${CONTAINER_PNPM}"
    fi

    echo "Development preparation complete: Node ${CONTAINER_NODE}, pnpm ${CONTAINER_PNPM}, frozen dependencies verified."
    ;;
  *)
    _fail "ERROR: Unknown action '$ACTION'. Authorized actions: none (provider preflight) or 'prepare'."
    ;;
esac
