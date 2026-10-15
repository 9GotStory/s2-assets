#!/usr/bin/env bash
_is_sourced=0
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  _is_sourced=1
fi

if [ "$_is_sourced" -eq 0 ]; then
  set -euo pipefail
fi

# Ensure deterministic Compose provider is selected
export PODMAN_COMPOSE_PROVIDER=podman-compose

_run_preflight() {
  # 1. Verify podman is available
  if ! command -v podman >/dev/null 2>&1; then
    echo "ERROR: podman is not installed or not in PATH" >&2
    return 1
  fi

  # 2. Verify podman-compose is available
  if ! command -v podman-compose >/dev/null 2>&1; then
    echo "ERROR: podman-compose is not installed or not in PATH" >&2
    return 1
  fi

  # 3. Verify podman compose provider preflight resolves to podman-compose 1.6.0
  local version_output clean_version_output
  if ! version_output=$(podman compose version 2>&1); then
    echo "ERROR: Failed to query podman compose version: ${version_output}" >&2
    return 1
  fi

  clean_version_output=$(echo "${version_output}" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g')

  if ! echo "${clean_version_output}" | grep -Eq "^podman-compose version 1\.6\.0[[:space:]]*$"; then
    echo "ERROR: Requires podman-compose 1.6.0" >&2
    return 1
  fi

  echo "Compose provider preflight verified: podman-compose 1.6.0 (PODMAN_COMPOSE_PROVIDER=${PODMAN_COMPOSE_PROVIDER})"
  return 0
}

# If sourced, execute preflight only and return immediately, ignoring inherited caller arguments
if [ "$_is_sourced" -eq 1 ]; then
  _run_preflight
  return $?
fi

# Executed directly: run preflight first
if ! _run_preflight; then
  exit 1
fi

# If invoked directly without arguments, preflight is complete
if [ $# -eq 0 ]; then
  exit 0
fi

_fail() {
  echo "$1" >&2
  exit 1
}

_validate_foundation_env_file() {
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

  # Validate required keys and constraints as whole values without secret leakage
  if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
    _fail "ERROR: COMPOSE_PROJECT_NAME is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$COMPOSE_PROJECT_NAME" in
    *$'\n'*|*$'\r'*) _fail "ERROR: COMPOSE_PROJECT_NAME cannot contain line breaks" ;;
  esac
  if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9_-]+$ ]]; then
    _fail "ERROR: COMPOSE_PROJECT_NAME must be lowercase alphanumeric with hyphens or underscores"
  fi
  if [ "$COMPOSE_PROJECT_NAME" = "s2-assets" ] || [ "$COMPOSE_PROJECT_NAME" = "default" ]; then
    _fail "ERROR: COMPOSE_PROJECT_NAME must be a unique project name, not shared default"
  fi

  if [ -z "${POSTGRES_DB:-}" ]; then
    _fail "ERROR: POSTGRES_DB is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$POSTGRES_DB" in
    *$'\n'*|*$'\r'*) _fail "ERROR: POSTGRES_DB cannot contain line breaks" ;;
  esac
  if [[ ! "$POSTGRES_DB" =~ ^s2_foundation_[a-zA-Z0-9_]+$ ]]; then
    _fail "ERROR: POSTGRES_DB must begin with 's2_foundation_' and contain only alphanumeric/underscore characters"
  fi
  if [ "$POSTGRES_DB" = "s2_foundation_s2_assets" ] || [ "$POSTGRES_DB" = "s2_assets" ]; then
    _fail "ERROR: POSTGRES_DB cannot use repository default names"
  fi

  if [ -z "${POSTGRES_USER:-}" ]; then
    _fail "ERROR: POSTGRES_USER is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$POSTGRES_USER" in
    *$'\n'*|*$'\r'*) _fail "ERROR: POSTGRES_USER cannot contain line breaks" ;;
  esac
  if [[ ! "$POSTGRES_USER" =~ ^[a-zA-Z0-9_]+$ ]]; then
    _fail "ERROR: POSTGRES_USER must be alphanumeric with underscores (safe for database URL construction)"
  fi
  if [ "$POSTGRES_USER" = "s2_user" ] || [ "$POSTGRES_USER" = "postgres" ] || [ "$POSTGRES_USER" = "admin" ] || [ "$POSTGRES_USER" = "root" ]; then
    _fail "ERROR: POSTGRES_USER cannot use default or privileged usernames"
  fi

  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    _fail "ERROR: POSTGRES_PASSWORD is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$POSTGRES_PASSWORD" in
    *$'\n'*|*$'\r'*) _fail "ERROR: POSTGRES_PASSWORD cannot contain line breaks" ;;
  esac
  if [[ ! "$POSTGRES_PASSWORD" =~ ^[0-9a-fA-F]{16,}$ ]]; then
    _fail "ERROR: POSTGRES_PASSWORD must be a hexadecimal secret of at least 16 characters (safe for URL construction without delimiters or whitespace)"
  fi
  if [ "$POSTGRES_PASSWORD" = "s2_password" ] || [ "$POSTGRES_PASSWORD" = "password" ] || [ "$POSTGRES_PASSWORD" = "postgres" ] || [ "$POSTGRES_PASSWORD" = "admin" ]; then
    _fail "ERROR: POSTGRES_PASSWORD cannot use default or insecure passwords"
  fi

  if [ -z "${COOKIE_SECRET:-}" ]; then
    _fail "ERROR: COOKIE_SECRET is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$COOKIE_SECRET" in
    *$'\n'*|*$'\r'*) _fail "ERROR: COOKIE_SECRET cannot contain line breaks" ;;
  esac
  if [[ ! "$COOKIE_SECRET" =~ ^[0-9a-fA-F]{64,}$ ]]; then
    _fail "ERROR: COOKIE_SECRET must be a hexadecimal signing secret of at least 32 bytes (64 hex characters) without whitespace"
  fi
  if [ "$COOKIE_SECRET" = "secret" ] || [ "$COOKIE_SECRET" = "cookie_secret" ]; then
    _fail "ERROR: COOKIE_SECRET cannot use default secrets"
  fi

  if [ -z "${FOUNDATION_TEST_RUN_ID:-}" ]; then
    _fail "ERROR: FOUNDATION_TEST_RUN_ID is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$FOUNDATION_TEST_RUN_ID" in
    *$'\n'*|*$'\r'*) _fail "ERROR: FOUNDATION_TEST_RUN_ID cannot contain line breaks" ;;
  esac
  if [[ ! "$FOUNDATION_TEST_RUN_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    _fail "ERROR: FOUNDATION_TEST_RUN_ID must be alphanumeric with hyphens or underscores"
  fi

  if [ -z "${FOUNDATION_TEST_USERNAME:-}" ]; then
    _fail "ERROR: FOUNDATION_TEST_USERNAME is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$FOUNDATION_TEST_USERNAME" in
    *$'\n'*|*$'\r'*) _fail "ERROR: FOUNDATION_TEST_USERNAME cannot contain line breaks" ;;
  esac
  if [[ ! "$FOUNDATION_TEST_USERNAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    _fail "ERROR: FOUNDATION_TEST_USERNAME must be alphanumeric with hyphens or underscores"
  fi

  if [ -z "${FOUNDATION_TEST_PASSWORD:-}" ]; then
    _fail "ERROR: FOUNDATION_TEST_PASSWORD is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$FOUNDATION_TEST_PASSWORD" in
    *$'\n'*|*$'\r'*) _fail "ERROR: FOUNDATION_TEST_PASSWORD cannot contain line breaks" ;;
  esac
  TEST_PW_NON_WS="${FOUNDATION_TEST_PASSWORD//[[:space:]]/}"
  if [ ${#TEST_PW_NON_WS} -lt 8 ]; then
    _fail "ERROR: FOUNDATION_TEST_PASSWORD must contain at least 8 non-whitespace characters"
  fi
  TEST_PW_TRIMMED="${FOUNDATION_TEST_PASSWORD#"${FOUNDATION_TEST_PASSWORD%%[![:space:]]*}"}"
  TEST_PW_TRIMMED="${TEST_PW_TRIMMED%"${TEST_PW_TRIMMED##*[![:space:]]}"}"
  if [ "$TEST_PW_TRIMMED" = "password" ] || [ "$TEST_PW_TRIMMED" = "test" ] || [ "$TEST_PW_TRIMMED" = "admin" ] || [ "$TEST_PW_TRIMMED" = "s2_password" ]; then
    _fail "ERROR: FOUNDATION_TEST_PASSWORD cannot use default or trivial passwords"
  fi
}

_validate_fixture_database_url() {
  if [ -z "${FOUNDATION_TEST_DATABASE_URL:-}" ]; then
    _fail "ERROR: FOUNDATION_TEST_DATABASE_URL is required in ${FOUNDATION_ENV_FILE}"
  fi
  case "$FOUNDATION_TEST_DATABASE_URL" in
    *$'\n'*|*$'\r'*) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL cannot contain line breaks" ;;
  esac

  local VALIDATION_EXIT=0
  python3 -c '
import os, sys, re
from urllib.parse import urlparse, parse_qs, unquote

url = os.environ.get("FOUNDATION_TEST_DATABASE_URL", "")
if not url.startswith("postgresql://") and not url.startswith("postgres://"):
    sys.exit(10)

try:
    p = urlparse(url)
except Exception:
    sys.exit(10)

qs = parse_qs(p.query)

all_hosts = []
if p.hostname:
    all_hosts.append(p.hostname)
if "host" in qs:
    all_hosts.extend(qs["host"])

def is_prod(h):
    h_lower = unquote(h or "").lower()
    return any(s in h_lower for s in ["prod", "production", "s2.internal", "aws", "rds", "azure", "cloudsql"])

for h in all_hosts:
    if is_prod(h):
        sys.exit(20)

effective_host = (qs.get("host", [p.hostname])[-1] or "").lower()
if not effective_host or is_prod(effective_host):
    sys.exit(20)

path = p.path.lstrip("/")
if not path:
    sys.exit(30)

if not re.match(r"^s2_foundation_[a-zA-Z0-9_]+$", path):
    sys.exit(31)

if path in ["s2_assets", "s2_foundation_s2_assets", "postgres", "default"]:
    sys.exit(32)

expected_db = os.environ.get("POSTGRES_DB", "")
if path != expected_db:
    sys.exit(33)

sys.exit(0)
' || VALIDATION_EXIT=$?

  case "$VALIDATION_EXIT" in
    0) ;;
    10) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL must be a valid PostgreSQL connection URL" ;;
    20) _fail "ERROR: Production database target is prohibited in FOUNDATION_TEST_DATABASE_URL" ;;
    30) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL database name is missing" ;;
    31) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL database name must begin with 's2_foundation_' and contain only alphanumeric/underscore characters" ;;
    32) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL cannot use default or shared database name" ;;
    33) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL database target does not match POSTGRES_DB '${POSTGRES_DB}'" ;;
    *) _fail "ERROR: FOUNDATION_TEST_DATABASE_URL validation failed (code ${VALIDATION_EXIT})" ;;
  esac
}

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

    _validate_foundation_env_file

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
  test-identity)
    SUB_ACTION="${1:-}"
    if [ "$SUB_ACTION" != "setup" ] && [ "$SUB_ACTION" != "cleanup" ]; then
      _fail "ERROR: test-identity requires a subaction: 'setup' or 'cleanup'"
    fi

    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
    COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

    if [ ! -f "$COMPOSE_FILE" ]; then
      _fail "ERROR: Compose file not found at ${COMPOSE_FILE}"
    fi

    _validate_foundation_env_file
    _validate_fixture_database_url

    ENV_DIR=$(dirname "$FOUNDATION_ENV_FILE")
    STATE_FILE="${ENV_DIR}/fixture-state-${FOUNDATION_TEST_RUN_ID}.json"
    RUNNER_CONFIG_FILE="${ENV_DIR}/.fixture-runner-${FOUNDATION_TEST_RUN_ID}.json"

    (
      umask 077
      python3 -c '
import json, os, sys
keys = [
    "NODE_ENV",
    "FOUNDATION_TEST_RUN_ID",
    "FOUNDATION_TEST_USERNAME",
    "FOUNDATION_TEST_PASSWORD",
    "FOUNDATION_TEST_DATABASE_URL",
    "FOUNDATION_FIXTURE_STATE_FILE",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "COOKIE_SECRET",
    "COMPOSE_PROJECT_NAME"
]
data = {k: os.environ.get(k, "") for k in keys}
target_file = sys.argv[1]
with open(target_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
' "$RUNNER_CONFIG_FILE"
      chmod 600 "$RUNNER_CONFIG_FILE"
    )

    _clean_runner_config() {
      rm -f "$RUNNER_CONFIG_FILE"
    }
    trap _clean_runner_config EXIT INT TERM

    set +e
    podman compose --env-file "$FOUNDATION_ENV_FILE" \
      -p "$COMPOSE_PROJECT_NAME" \
      -f "$COMPOSE_FILE" \
      run --rm --no-deps -T \
      -v "${ENV_DIR}:${ENV_DIR}:z" \
      -e NODE_ENV=test \
      -e FOUNDATION_TEST_RUN_ID="${FOUNDATION_TEST_RUN_ID}" \
      -e FOUNDATION_FIXTURE_CONFIG_FILE="${RUNNER_CONFIG_FILE}" \
      -e FOUNDATION_FIXTURE_STATE_FILE="${STATE_FILE}" \
      api pnpm --filter api test:identity "$SUB_ACTION"
    RUN_EXIT=$?
    set -e

    _clean_runner_config
    trap - EXIT INT TERM

    exit $RUN_EXIT
    ;;
  *)
    _fail "ERROR: Unknown action '$ACTION'. Authorized actions: none (provider preflight), 'prepare', or 'test-identity'."
    ;;
esac
