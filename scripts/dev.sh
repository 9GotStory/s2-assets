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

  # Validate path is outside repository checkout (lexical and canonical symlink resolution)
  CANONICAL_REPO_ROOT=$(realpath "$REPO_ROOT" 2>/dev/null || readlink -f "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")
  CANONICAL_ENV_FILE=$(realpath "$FOUNDATION_ENV_FILE" 2>/dev/null || readlink -f "$FOUNDATION_ENV_FILE" 2>/dev/null || echo "$FOUNDATION_ENV_FILE")
  LEXICAL_ENV_FILE=$(realpath -s "$FOUNDATION_ENV_FILE" 2>/dev/null || echo "$FOUNDATION_ENV_FILE")

  case "$FOUNDATION_ENV_FILE" in
    "${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
      ;;
  esac
  case "$LEXICAL_ENV_FILE" in
    "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
      ;;
  esac
  case "$CANONICAL_ENV_FILE" in
    "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
      ;;
  esac

  # Validate file existence
  if [ ! -f "$FOUNDATION_ENV_FILE" ]; then
    _fail "ERROR: FOUNDATION_ENV_FILE not found: ${FOUNDATION_ENV_FILE}"
  fi

  # Validate file permissions (must not be group/other accessible)
  FILE_MODE=$(stat -c "%a" "$FOUNDATION_ENV_FILE" 2>/dev/null || stat -f "%OLp" "$FOUNDATION_ENV_FILE" 2>/dev/null || true)
  if [ -n "$FILE_MODE" ]; then
    FILE_TAIL="${FILE_MODE: -2}"
    if [ "$FILE_TAIL" != "00" ]; then
      _fail "ERROR: Insecure permissions on ${FOUNDATION_ENV_FILE}: mode must be 600 or 400 (got ${FILE_MODE})"
    fi
  fi

  # Validate directory permissions and boundary (must not be group/other accessible or inside repo)
  ENV_DIR=$(dirname "$FOUNDATION_ENV_FILE")
  CANONICAL_ENV_DIR=$(realpath "$ENV_DIR" 2>/dev/null || readlink -f "$ENV_DIR" 2>/dev/null || echo "$ENV_DIR")
  LEXICAL_ENV_DIR=$(realpath -s "$ENV_DIR" 2>/dev/null || echo "$ENV_DIR")
  case "$ENV_DIR" in
    "${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: Environment directory must reside outside repository checkout: ${ENV_DIR}"
      ;;
  esac
  case "$LEXICAL_ENV_DIR" in
    "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: Environment directory must reside outside repository checkout: ${ENV_DIR}"
      ;;
  esac
  case "$CANONICAL_ENV_DIR" in
    "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: Environment directory must reside outside repository checkout: ${ENV_DIR}"
      ;;
  esac
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
    if [ -n "${FOUNDATION_FIXTURE_STATE_FILE:-}" ]; then
      STATE_FILE="${FOUNDATION_FIXTURE_STATE_FILE}"
    fi
    CANONICAL_STATE_FILE=$(realpath "$STATE_FILE" 2>/dev/null || readlink -f "$STATE_FILE" 2>/dev/null || echo "$STATE_FILE")
    LEXICAL_STATE_FILE=$(realpath -s "$STATE_FILE" 2>/dev/null || echo "$STATE_FILE")
    case "$STATE_FILE" in
      "${REPO_ROOT}"/*|"${REPO_ROOT}")
        _fail "ERROR: Fixture state file must reside outside repository checkout: ${STATE_FILE}"
        ;;
    esac
    case "$LEXICAL_STATE_FILE" in
      "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
        _fail "ERROR: Fixture state file must reside outside repository checkout: ${STATE_FILE}"
        ;;
    esac
    case "$CANONICAL_STATE_FILE" in
      "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
        _fail "ERROR: Fixture state file must reside outside repository checkout: ${STATE_FILE}"
        ;;
    esac
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
  http-smoke)
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
    if [ -n "${FOUNDATION_FIXTURE_STATE_FILE:-}" ]; then
      STATE_FILE="${FOUNDATION_FIXTURE_STATE_FILE}"
    fi
    CANONICAL_STATE_FILE=$(realpath "$STATE_FILE" 2>/dev/null || readlink -f "$STATE_FILE" 2>/dev/null || echo "$STATE_FILE")
    LEXICAL_STATE_FILE=$(realpath -s "$STATE_FILE" 2>/dev/null || echo "$STATE_FILE")
    case "$STATE_FILE" in
      "${REPO_ROOT}"/*|"${REPO_ROOT}")
        _fail "ERROR: Fixture state file must reside outside repository checkout: ${STATE_FILE}"
        ;;
    esac
    case "$LEXICAL_STATE_FILE" in
      "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
        _fail "ERROR: Fixture state file must reside outside repository checkout: ${STATE_FILE}"
        ;;
    esac
    case "$CANONICAL_STATE_FILE" in
      "${CANONICAL_REPO_ROOT}"/*|"${CANONICAL_REPO_ROOT}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
        _fail "ERROR: Fixture state file must reside outside repository checkout: ${STATE_FILE}"
        ;;
    esac
    # Ensure fixture state file exists before running smoke suite
    if [ ! -f "$STATE_FILE" ]; then
      _fail "ERROR: Fixture state file not found at ${STATE_FILE}. Prepare fixtures with 'bash scripts/dev.sh test-identity setup' before running http-smoke."
    fi

    RUNNER_CONFIG_FILE="${ENV_DIR}/.smoke-runner-${FOUNDATION_TEST_RUN_ID}.json"
    SMOKE_SESSION_FILE="${ENV_DIR}/.smoke-session-${FOUNDATION_TEST_RUN_ID}.json"

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
    "FOUNDATION_SMOKE_SESSION_FILE",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "COOKIE_SECRET",
    "COMPOSE_PROJECT_NAME",
    "API_HOST_PORT",
    "WEB_HOST_PORT"
]
data = {k: os.environ.get(k, "") for k in keys}
target_file = sys.argv[1]
with open(target_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
' "$RUNNER_CONFIG_FILE"
      chmod 600 "$RUNNER_CONFIG_FILE"
    )

    PG_INTERRUPTED=0
    FIRST_FAILURE_EXIT=0
    RESTORE_FAILED=0
    CLEANUP_FAILED=0

    # R5: Helper to restore PostgreSQL and verify readiness
    _restore_postgres() {
      if [ "$PG_INTERRUPTED" -ne 1 ]; then
        return 0
      fi
      echo "PostgreSQL service is currently interrupted; restoring..." >&2

      # R5: Simulation hook for forced restoration failure
      if [ "${FOUNDATION_SMOKE_SIMULATE_FAIL:-}" = "restoration_fail" ]; then
        echo "Simulating deliberate restoration failure for Case E verification..." >&2
        RESTORE_FAILED=1
        return 1
      fi

      if ! podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" start postgres >/dev/null 2>&1; then
        echo "ERROR: Failed to issue start command to postgres container for ${COMPOSE_PROJECT_NAME}" >&2
        RESTORE_FAILED=1
        return 1
      fi

      local ready=0
      for attempt in {1..30}; do
        if podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
          echo "PostgreSQL service restored and ready (attempt ${attempt})." >&2
          ready=1
          break
        fi
        sleep 1
      done

      if [ "$ready" -eq 1 ]; then
        PG_INTERRUPTED=0
        return 0
      else
        echo "ERROR: Timed out waiting for PostgreSQL service to become ready after 30 attempts" >&2
        RESTORE_FAILED=1
        return 1
      fi
    }

    # R2: Helper to clean fixtures using existing accepted T044 tooling
    _run_fixture_cleanup() {
      if [ ! -f "$STATE_FILE" ]; then
        return 0
      fi
      echo "Executing authorized fixture cleanup for run ${FOUNDATION_TEST_RUN_ID}..." >&2

      # Simulation hook for cleanup failure verification
      if [ "${FOUNDATION_SMOKE_SIMULATE_FAIL:-}" = "cleanup_fail" ]; then
        echo "Simulating deliberate cleanup failure for Case E verification..." >&2
        CLEANUP_FAILED=1
        return 1
      fi

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
        api pnpm --filter api test:identity cleanup
      local c_exit=$?
      set -e

      if [ "$c_exit" -ne 0 ]; then
        echo "ERROR: Fixture cleanup failed with exit code ${c_exit}" >&2
        CLEANUP_FAILED=1
        return 1
      fi
      return 0
    }

    _clean_smoke_resources() {
      local orig_exit="${1:-0}"
      local trap_signal="${2:-0}"
      trap - EXIT INT TERM

      # If an unhandled error or exit occurred, record it in FIRST_FAILURE_EXIT if not already set
      if [ "$FIRST_FAILURE_EXIT" -eq 0 ] && [ "$orig_exit" -ne 0 ]; then
        FIRST_FAILURE_EXIT="$orig_exit"
      fi

      # 1. Restore PostgreSQL first
      if [ "$PG_INTERRUPTED" -eq 1 ]; then
        _restore_postgres || true
      fi

      # 2. Run fixture cleanup if PostgreSQL is operational
      if [ "$RESTORE_FAILED" -eq 0 ]; then
        _run_fixture_cleanup || true
      else
        echo "WARNING: Skipping fixture cleanup due to incomplete PostgreSQL recovery; retaining state file ${STATE_FILE}" >&2
      fi

      # 3. Retain ownership/recovery state if recovery or cleanup failed
      if [ "$RESTORE_FAILED" -eq 0 ] && [ "$CLEANUP_FAILED" -eq 0 ]; then
        rm -f "$RUNNER_CONFIG_FILE" 2>/dev/null || true
        rm -f "$SMOKE_SESSION_FILE" 2>/dev/null || true
      else
        echo "WARNING: Incomplete lifecycle cleanup; retaining private runner configuration (${RUNNER_CONFIG_FILE}) and state files for recovery inspection." >&2
      fi

      # 4. Exit code precedence:
      if [ "$FIRST_FAILURE_EXIT" -ne 0 ]; then
        exit "$FIRST_FAILURE_EXIT"
      fi
      if [ "$trap_signal" -ne 0 ]; then
        exit "$trap_signal"
      fi
      if [ "$RESTORE_FAILED" -ne 0 ]; then
        exit 1
      fi
      if [ "$CLEANUP_FAILED" -ne 0 ]; then
        exit 1
      fi
      exit 0
    }

    trap '_clean_smoke_resources "$?" 0' EXIT
    trap '_clean_smoke_resources 130 130' INT
    trap '_clean_smoke_resources 143 143' TERM

    # Phase 1: Pre-outage smoke (A1, A2, B1, B2, B3, C1, C2)
    echo "Running HTTP smoke Phase 1 (Pre-outage baseline: Cases A1, A2, B1, B2, B3, C1, C2)..."
    set +e
    podman compose --env-file "$FOUNDATION_ENV_FILE" \
      -p "$COMPOSE_PROJECT_NAME" \
      -f "$COMPOSE_FILE" \
      run --rm --no-deps -T \
      -v "${ENV_DIR}:${ENV_DIR}:z" \
      -e NODE_ENV=test \
      -e HTTP_API_URL="http://api:3000" \
      -e HTTP_WEB_URL="http://web:5173" \
      -e FOUNDATION_SMOKE_PHASE="pre-outage" \
      -e FOUNDATION_TEST_RUN_ID="${FOUNDATION_TEST_RUN_ID}" \
      -e FOUNDATION_FIXTURE_CONFIG_FILE="${RUNNER_CONFIG_FILE}" \
      -e FOUNDATION_FIXTURE_STATE_FILE="${STATE_FILE}" \
      -e FOUNDATION_SMOKE_SESSION_FILE="${SMOKE_SESSION_FILE}" \
      api pnpm --filter api test:http
    PHASE1_EXIT=$?
    set -e

    if [ "$PHASE1_EXIT" -ne 0 ]; then
      FIRST_FAILURE_EXIT=$PHASE1_EXIT
      echo "ERROR: HTTP smoke Phase 1 failed with exit code ${PHASE1_EXIT}" >&2
      exit "$PHASE1_EXIT"
    fi

    # Phase 2: Database outage (Case D1)
    # R3: Verify exact test-owned Compose/PostgreSQL identity before interruption
    echo "Verifying test-owned container identity before service interruption..."
    case "$COMPOSE_PROJECT_NAME" in
      s2_*) ;;
      *) _fail "ERROR: COMPOSE_PROJECT_NAME must begin with 's2_': ${COMPOSE_PROJECT_NAME}" ;;
    esac
    case "$POSTGRES_DB" in
      s2_foundation_*) ;;
      *) _fail "ERROR: POSTGRES_DB must begin with 's2_foundation_': ${POSTGRES_DB}" ;;
    esac
    if [ "$POSTGRES_DB" = "s2_assets" ] || [ "$POSTGRES_DB" = "postgres" ] || [ "$POSTGRES_DB" = "default" ]; then
      _fail "ERROR: Prohibited target database for interruption: ${POSTGRES_DB}"
    fi

    PG_CONTAINER_ID=$(podman ps -a --filter "label=io.podman.compose.project=${COMPOSE_PROJECT_NAME}" --filter "label=io.podman.compose.service=postgres" -q 2>/dev/null | head -n 1 || true)
    if [ -z "$PG_CONTAINER_ID" ]; then
      PG_CONTAINER_ID=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*postgres" -q 2>/dev/null | head -n 1 || true)
    fi
    if [ -z "$PG_CONTAINER_ID" ]; then
      _fail "ERROR: Cannot resolve PostgreSQL container for project ${COMPOSE_PROJECT_NAME}; refusing interruption"
    fi

    PG_CONTAINER_NAME=$(podman inspect --format '{{.Name}}' "$PG_CONTAINER_ID" 2>/dev/null || true)
    case "$PG_CONTAINER_NAME" in
      *"${COMPOSE_PROJECT_NAME}"*postgres*) ;;
      *) _fail "ERROR: Container name ${PG_CONTAINER_NAME} does not match expected owned project ${COMPOSE_PROJECT_NAME}; refusing interruption" ;;
    esac

    # R5: Record recovery responsibility BEFORE interrupting the service
    PG_INTERRUPTED=1
    echo "Interrupting PostgreSQL service for project ${COMPOSE_PROJECT_NAME}..."
    podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" stop postgres

    # Deliberate failure simulation for Case E testing if requested
    if [ "${FOUNDATION_SMOKE_SIMULATE_FAIL:-}" = "outage" ]; then
      FIRST_FAILURE_EXIT=42
      echo "Simulating deliberate failure in outage phase (exit code 42) for Case E lifecycle verification..." >&2
      exit 42
    fi

    echo "Running HTTP smoke Phase 2 (Database outage assertions: Case D1)..."
    set +e
    podman compose --env-file "$FOUNDATION_ENV_FILE" \
      -p "$COMPOSE_PROJECT_NAME" \
      -f "$COMPOSE_FILE" \
      run --rm --no-deps -T \
      -v "${ENV_DIR}:${ENV_DIR}:z" \
      -e NODE_ENV=test \
      -e HTTP_API_URL="http://api:3000" \
      -e HTTP_WEB_URL="http://web:5173" \
      -e FOUNDATION_SMOKE_PHASE="outage" \
      -e FOUNDATION_TEST_RUN_ID="${FOUNDATION_TEST_RUN_ID}" \
      -e FOUNDATION_FIXTURE_CONFIG_FILE="${RUNNER_CONFIG_FILE}" \
      -e FOUNDATION_FIXTURE_STATE_FILE="${STATE_FILE}" \
      -e FOUNDATION_SMOKE_SESSION_FILE="${SMOKE_SESSION_FILE}" \
      api pnpm --filter api test:http
    PHASE2_EXIT=$?
    set -e

    if [ "$PHASE2_EXIT" -ne 0 ]; then
      FIRST_FAILURE_EXIT=$PHASE2_EXIT
      echo "ERROR: HTTP smoke Phase 2 failed with exit code ${PHASE2_EXIT}" >&2
      exit "$PHASE2_EXIT"
    fi

    # Phase 3: Database recovery (Case D2)
    echo "Restoring PostgreSQL service for project ${COMPOSE_PROJECT_NAME}..."
    if ! _restore_postgres; then
      FIRST_FAILURE_EXIT=1
      echo "ERROR: Failed to restore PostgreSQL service for project ${COMPOSE_PROJECT_NAME}" >&2
      exit 1
    fi

    # Deliberate failure simulation for Case E testing if requested
    if [ "${FOUNDATION_SMOKE_SIMULATE_FAIL:-}" = "recovery" ]; then
      FIRST_FAILURE_EXIT=43
      echo "Simulating deliberate failure in recovery phase (exit code 43) for Case E lifecycle verification..." >&2
      exit 43
    fi

    echo "Running HTTP smoke Phase 3 (Database recovery assertions: Case D2)..."
    set +e
    podman compose --env-file "$FOUNDATION_ENV_FILE" \
      -p "$COMPOSE_PROJECT_NAME" \
      -f "$COMPOSE_FILE" \
      run --rm --no-deps -T \
      -v "${ENV_DIR}:${ENV_DIR}:z" \
      -e NODE_ENV=test \
      -e HTTP_API_URL="http://api:3000" \
      -e HTTP_WEB_URL="http://web:5173" \
      -e FOUNDATION_SMOKE_PHASE="recovery" \
      -e FOUNDATION_TEST_RUN_ID="${FOUNDATION_TEST_RUN_ID}" \
      -e FOUNDATION_FIXTURE_CONFIG_FILE="${RUNNER_CONFIG_FILE}" \
      -e FOUNDATION_FIXTURE_STATE_FILE="${STATE_FILE}" \
      -e FOUNDATION_SMOKE_SESSION_FILE="${SMOKE_SESSION_FILE}" \
      api pnpm --filter api test:http
    PHASE3_EXIT=$?
    set -e

    if [ "$PHASE3_EXIT" -ne 0 ]; then
      FIRST_FAILURE_EXIT=$PHASE3_EXIT
      echo "ERROR: HTTP smoke Phase 3 failed with exit code ${PHASE3_EXIT}" >&2
      exit "$PHASE3_EXIT"
    fi

    echo "HTTP smoke verification completed successfully."
    exit 0
    ;;
  e2e)
    # Parse options
    PREFLIGHT_ONLY=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --preflight|preflight)
          PREFLIGHT_ONLY=1
          shift
          ;;
        *)
          _fail "ERROR: Unknown option '$1' for e2e. Supported invocation: bash scripts/dev.sh e2e --preflight"
          ;;
      esac
    done

    # 1. Require valid initial E2E_BASE_URL if provided (omit raw URL in errors to prevent credential leakage)
    if [ -n "${E2E_BASE_URL:-}" ] && [ "$E2E_BASE_URL" != "http://web:5173" ]; then
      _fail "ERROR: Invalid E2E_BASE_URL. Expected exactly 'http://web:5173'"
    fi

    # 2. Check invocation mode: if not preflight, enforce T033 authorization gate
    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
    COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

    if [ "$PREFLIGHT_ONLY" -eq 0 ]; then
      if [ ! -f "${REPO_ROOT}/apps/web/tests/e2e/auth.spec.ts" ]; then
        _fail "ERROR: Browser test suite (apps/web/tests/e2e/auth.spec.ts) is not implemented. E2E browser execution requires separate T033 authorization. Use 'bash scripts/dev.sh e2e --preflight' for runtime preflight."
      fi
    fi

    # 3. Environment validation & sourcing private environment
    if [ ! -f "$COMPOSE_FILE" ]; then
      _fail "ERROR: Compose file not found at ${COMPOSE_FILE}"
    fi

    _validate_foundation_env_file

    # 4. Validate effective E2E_BASE_URL after loading private environment
    if [ -z "${E2E_BASE_URL:-}" ]; then
      _fail "ERROR: E2E_BASE_URL is required. Set E2E_BASE_URL=http://web:5173"
    fi
    if [ "$E2E_BASE_URL" != "http://web:5173" ]; then
      _fail "ERROR: Invalid E2E_BASE_URL. Expected exactly 'http://web:5173'"
    fi

    # 5. Validate test-owned Compose project and running Web service
    case "$COMPOSE_PROJECT_NAME" in
      s2-assets|default) _fail "ERROR: COMPOSE_PROJECT_NAME cannot use shared or default name" ;;
    esac

    MATCHING_WEB_CONTAINERS=$(podman ps --filter "label=io.podman.compose.project=${COMPOSE_PROJECT_NAME}" \
                                        --filter "label=io.podman.compose.service=web" \
                                        --format "{{.ID}}" 2>/dev/null || true)
    if [ -z "$MATCHING_WEB_CONTAINERS" ]; then
      MATCHING_WEB_CONTAINERS=$(podman ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
                                          --filter "label=com.docker.compose.service=web" \
                                          --format "{{.ID}}" 2>/dev/null || true)
    fi

    WEB_COUNT=$(echo "$MATCHING_WEB_CONTAINERS" | awk 'NF {c++} END {print c+0}')
    if [ "$WEB_COUNT" -eq 0 ]; then
      _fail "ERROR: Cannot resolve running web container for project '${COMPOSE_PROJECT_NAME}'. Ensure the web service is running with exact compose labels for project '${COMPOSE_PROJECT_NAME}' and service 'web'."
    fi
    if [ "$WEB_COUNT" -gt 1 ]; then
      _fail "ERROR: Multiple (${WEB_COUNT}) web containers detected for project '${COMPOSE_PROJECT_NAME}'. Ambiguous web service matches rejected."
    fi

    WEB_CONTAINER_ID=$(echo "$MATCHING_WEB_CONTAINERS" | tr -d '[:space:]')

    INSPECT_WEB_PROJECT=$(podman inspect "$WEB_CONTAINER_ID" --format '{{or (index .Config.Labels "io.podman.compose.project") (index .Config.Labels "com.docker.compose.project")}}' 2>/dev/null || true)
    INSPECT_WEB_SERVICE=$(podman inspect "$WEB_CONTAINER_ID" --format '{{or (index .Config.Labels "io.podman.compose.service") (index .Config.Labels "com.docker.compose.service")}}' 2>/dev/null || true)

    if [ "$INSPECT_WEB_PROJECT" != "$COMPOSE_PROJECT_NAME" ] || [ "$INSPECT_WEB_SERVICE" != "web" ]; then
      _fail "ERROR: Resolved web container '${WEB_CONTAINER_ID}' has invalid labels (project='${INSPECT_WEB_PROJECT}', service='${INSPECT_WEB_SERVICE}'); expected project '${COMPOSE_PROJECT_NAME}' and service 'web'"
    fi

    # 6. Resolve application network and assert isolation invariants
    CONTAINER_NETWORKS=$(podman inspect "$WEB_CONTAINER_ID" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null || true)
    NET_COUNT=$(echo "$CONTAINER_NETWORKS" | awk 'NF {c++} END {print c+0}')

    if [ "$NET_COUNT" -eq 0 ]; then
      _fail "ERROR: Web container '${WEB_CONTAINER_ID}' has no attached networks"
    fi
    if [ "$NET_COUNT" -gt 1 ]; then
      _fail "ERROR: Web container '${WEB_CONTAINER_ID}' has multiple (${NET_COUNT}) attached networks; Compose web service must only attach to the application network"
    fi

    APP_NETWORK=$(echo "$CONTAINER_NETWORKS" | tr -d '[:space:]')

    if ! podman network exists "$APP_NETWORK" 2>/dev/null; then
      _fail "ERROR: Application network '${APP_NETWORK}' for project '${COMPOSE_PROJECT_NAME}' does not exist"
    fi

    case "$APP_NETWORK" in
      host|bridge|podman|none)
        _fail "ERROR: Resolved network '${APP_NETWORK}' is a host or system network; runner must attach only to application network"
        ;;
      *database*|*db*)
        _fail "ERROR: Resolved network '${APP_NETWORK}' is a database network; runner must attach only to application network"
        ;;
    esac

    case "$APP_NETWORK" in
      "${COMPOSE_PROJECT_NAME}_default"|"${COMPOSE_PROJECT_NAME}-app")
        ;;
      *)
        _fail "ERROR: Resolved network '${APP_NETWORK}' does not match accepted Compose application network topology (${COMPOSE_PROJECT_NAME}_default or ${COMPOSE_PROJECT_NAME}-app)"
        ;;
    esac

    NET_INTERNAL=$(podman network inspect "$APP_NETWORK" --format '{{.Internal}}' 2>/dev/null || true)
    if [ "$NET_INTERNAL" = "true" ]; then
      _fail "ERROR: Resolved network '${APP_NETWORK}' is marked internal (database role); runner must attach only to application network"
    fi

    NET_PROJECT=$(podman network inspect "$APP_NETWORK" --format '{{or (index .Labels "io.podman.compose.project") (index .Labels "com.docker.compose.project")}}' 2>/dev/null || true)
    if [ "$NET_PROJECT" != "$COMPOSE_PROJECT_NAME" ]; then
      _fail "ERROR: Application network '${APP_NETWORK}' project label '${NET_PROJECT}' does not match expected project '${COMPOSE_PROJECT_NAME}'"
    fi

    # 7. Ensure isolated Playwright runner image exists
    RUNNER_IMAGE="s2-assets-e2e-runner:local"
    if ! podman image exists "$RUNNER_IMAGE" 2>/dev/null; then
      echo "Building isolated Playwright runner image (${RUNNER_IMAGE})..."
      podman build -t "$RUNNER_IMAGE" - <<'EOF'
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1 --no-same-owner
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && \
    corepack prepare pnpm@12.9.1 --activate && \
    pnpm --version && \
    chmod -R 777 /usr/local/share/corepack
ENV HOME=/tmp
ENV PNPM_HOME=/tmp/.pnpm
ENV PATH=$PNPM_HOME:/usr/local/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /workspace
EOF
    fi

    # 8. Prepare collision-safe identity and invocation-isolated paths
    INVOCATION_ID="inv-$$-$(od -vN 4 -An -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || date +%s%N 2>/dev/null || echo "$$")"
    RUNNER_CONTAINER_NAME="${FOUNDATION_E2E_RUNNER_NAME:-s2-e2e-runner-${FOUNDATION_TEST_RUN_ID:-run}-${INVOCATION_ID}}"
    RUNNER_CID_FILE="/tmp/s2-e2e-cid-${INVOCATION_ID}.cid"
    RUNNER_CREATE_ERR_FILE="/tmp/s2-create-err-${INVOCATION_ID}.log"
    RUNNER_WORKSPACE=$(mktemp -d -p /tmp s2-e2e-workspace-XXXXXX)
    PREFLIGHT_DIAG_LOG="${ENV_DIR}/s2-e2e-preflight-${INVOCATION_ID}.log"
    touch "$PREFLIGHT_DIAG_LOG"
    chmod 600 "$PREFLIGHT_DIAG_LOG" 2>/dev/null || true
    FIRST_FAILURE_EXIT=0
    CLEANUP_FAILED=0

    _sanitize_stream() {
      python3 "${SCRIPT_DIR}/e2e_diagnostics.py" filter
    }

    _process_bounded_stream() {
      local log_path="$1"
      local stream_mode="${2:-sink}"
      if [ "${FOUNDATION_E2E_SIMULATE_SANITIZER_FAIL:-0}" = "1" ]; then
        python3 "${SCRIPT_DIR}/e2e_diagnostics.py" filter >/dev/null 2>&1 || true
        echo "ERROR: Simulated diagnostic stream processor failure (exit code 1)" >&2
        return 1
      fi
      if [ "$stream_mode" = "filter" ] || [ -z "$log_path" ]; then
        python3 "${SCRIPT_DIR}/e2e_diagnostics.py" filter
      elif [ "$stream_mode" = "tee" ]; then
        python3 "${SCRIPT_DIR}/e2e_diagnostics.py" tee --log-file "$log_path"
      else
        python3 "${SCRIPT_DIR}/e2e_diagnostics.py" sink --log-file "$log_path"
      fi
    }

    _sanitize_diagnostic_log() {
      local log_file="$1"
      [ -f "$log_file" ] || return 0
      python3 "${SCRIPT_DIR}/e2e_diagnostics.py" sanitize-file "$log_file"
    }


    _clean_e2e_resources() {
      local orig_exit="${1:-0}"
      local trap_signal="${2:-0}"
      trap - EXIT INT TERM

      if [ "$FIRST_FAILURE_EXIT" -eq 0 ] && [ "$orig_exit" -ne 0 ]; then
        FIRST_FAILURE_EXIT="$orig_exit"
      fi

      # Clean up invocation-owned temporary create error file if it exists
      if [ -n "${RUNNER_CREATE_ERR_FILE:-}" ] && [ -f "$RUNNER_CREATE_ERR_FILE" ]; then
        if [ -s "$RUNNER_CREATE_ERR_FILE" ] && [ -f "$PREFLIGHT_DIAG_LOG" ]; then
          python3 "${SCRIPT_DIR}/e2e_diagnostics.py" append --log-file "$PREFLIGHT_DIAG_LOG" < "$RUNNER_CREATE_ERR_FILE" || true
        fi
        rm -f "$RUNNER_CREATE_ERR_FILE" 2>/dev/null || true
      fi

      # 1. Clean up container FIRST (before workspace) if CID handle exists
      local trapped_cid=""
      if [ -f "${RUNNER_CID_FILE:-}" ] && [ -s "${RUNNER_CID_FILE:-}" ]; then
        trapped_cid=$(cat "$RUNNER_CID_FILE" 2>/dev/null | tr -d '[:space:]')
      fi

      if [ -n "$trapped_cid" ]; then
        if podman container exists "$trapped_cid" 2>/dev/null; then
          local owner_label
          owner_label=$(podman inspect "$trapped_cid" --format '{{index .Config.Labels "io.s2-assets.invocation-id"}}' 2>/dev/null || true)
          if [ "$owner_label" = "$INVOCATION_ID" ]; then
            local rm_success=1
            if [ "${FOUNDATION_E2E_SIMULATE_CLEANUP_FAIL:-0}" = "1" ]; then
              rm_success=0
            elif ! podman rm -f -t 1 "$trapped_cid" >/dev/null 2>&1; then
              rm_success=0
            fi
            if [ "$rm_success" -eq 1 ]; then
              rm -f "$RUNNER_CID_FILE" 2>/dev/null || true
              trapped_cid=""
            else
              echo "ERROR: Failed to remove runner container ${trapped_cid}" >&2
              CLEANUP_FAILED=1
            fi
          else
            echo "ERROR: Container ${trapped_cid} does not match invocation label '${INVOCATION_ID}'; refusing to remove unowned container" >&2
            CLEANUP_FAILED=1
          fi
        else
          rm -f "$RUNNER_CID_FILE" 2>/dev/null || true
          trapped_cid=""
        fi
      fi

      # 2. Clean up workspace SECOND (only after container is confirmed removed)
      if [ -z "$trapped_cid" ]; then
        if [ -n "${RUNNER_WORKSPACE:-}" ] && [ -d "$RUNNER_WORKSPACE" ]; then
          if ! rm -rf "$RUNNER_WORKSPACE" 2>/dev/null; then
            echo "ERROR: Failed to remove runner workspace ${RUNNER_WORKSPACE}" >&2
            CLEANUP_FAILED=1
          else
            RUNNER_WORKSPACE=""
          fi
        fi
      fi

      # 3. Retain diagnostic artifact on failure, with exact non-secret resource identities
      if [ -f "$PREFLIGHT_DIAG_LOG" ]; then
        if [ "$FIRST_FAILURE_EXIT" -eq 0 ] && [ "$trap_signal" -eq 0 ] && [ "$CLEANUP_FAILED" -eq 0 ]; then
          rm -f "$PREFLIGHT_DIAG_LOG" 2>/dev/null || true
        else
          local rec_args=(
            --log-file "$PREFLIGHT_DIAG_LOG"
            --exit-status "$FIRST_FAILURE_EXIT"
            --trap-signal "$trap_signal"
            --cleanup-failed "$CLEANUP_FAILED"
            --project "$COMPOSE_PROJECT_NAME"
          )
          [ -n "$trapped_cid" ] && rec_args+=(--cid "$trapped_cid")
          [ -n "${RUNNER_WORKSPACE:-}" ] && [ -d "$RUNNER_WORKSPACE" ] && rec_args+=(--workspace "$RUNNER_WORKSPACE")
          local rec_exit=0
          python3 "${SCRIPT_DIR}/e2e_diagnostics.py" append-recovery "${rec_args[@]}" || rec_exit=$?
          if [ "$rec_exit" -ne 0 ]; then
            echo "WARNING: Preflight failed; unable to commit recovery metadata to ${PREFLIGHT_DIAG_LOG} (status ${rec_exit})" >&2
            [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT="$rec_exit"
          else
            echo "WARNING: Preflight failed; retaining sanitized diagnostic log at ${PREFLIGHT_DIAG_LOG}" >&2
          fi
        fi
      fi

      if [ "$FIRST_FAILURE_EXIT" -ne 0 ]; then
        exit "$FIRST_FAILURE_EXIT"
      fi
      if [ "$trap_signal" -ne 0 ]; then
        exit "$trap_signal"
      fi
      if [ "$CLEANUP_FAILED" -ne 0 ]; then
        exit 1
      fi
      exit 0
    }

    trap '_clean_e2e_resources "$?" 0' EXIT
    trap '_clean_e2e_resources 130 130' INT
    trap '_clean_e2e_resources 143 143' TERM

    _run_runner_stage() {
      local stage_name="$1"
      local attach_net="$2"
      shift 2

      local stage_container_name="${RUNNER_CONTAINER_NAME}"
      if [ -s "${RUNNER_CID_FILE:-}" ]; then
        local prev_cid
        prev_cid=$(cat "$RUNNER_CID_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$prev_cid" ] && podman container exists "$prev_cid" 2>/dev/null; then
          echo "ERROR: Previous runner container ${prev_cid} still exists; refusing to create container" >&2
          CLEANUP_FAILED=1
          [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT=1
          return 1
        fi
      fi
      rm -f "$RUNNER_CID_FILE" 2>/dev/null || true
      rm -f "$RUNNER_CREATE_ERR_FILE" 2>/dev/null || true

      local net_args=()
      if [ -n "$attach_net" ]; then
        net_args=(--network "$attach_net")
      fi

      # Use --cidfile so Podman writes CID atomically as container is created
      set +e
      podman create \
        --name "$stage_container_name" \
        --cidfile "$RUNNER_CID_FILE" \
        --label "io.s2-assets.invocation-id=${INVOCATION_ID}" \
        "${net_args[@]}" \
        -v "${RUNNER_WORKSPACE}:/workspace:z" \
        -w /workspace \
        -e HOME=/tmp \
        -e PNPM_HOME=/tmp/.pnpm \
        -e NODE_ENV=test \
        -e E2E_BASE_URL="${E2E_BASE_URL:-}" \
        "$RUNNER_IMAGE" \
        "$@" 2>"$RUNNER_CREATE_ERR_FILE"
      local create_exit=$?
      set -e

      if [ "$create_exit" -ne 0 ] || [ ! -s "$RUNNER_CID_FILE" ]; then
        [ "$create_exit" -eq 0 ] && create_exit=1
        [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT="$create_exit"
        if [ -f "$RUNNER_CREATE_ERR_FILE" ]; then
          if [ -s "$RUNNER_CREATE_ERR_FILE" ] && [ -f "$PREFLIGHT_DIAG_LOG" ]; then
            python3 "${SCRIPT_DIR}/e2e_diagnostics.py" append --log-file "$PREFLIGHT_DIAG_LOG" < "$RUNNER_CREATE_ERR_FILE" || true
          fi
          python3 "${SCRIPT_DIR}/e2e_diagnostics.py" filter < "$RUNNER_CREATE_ERR_FILE" >&2 || true
          rm -f "$RUNNER_CREATE_ERR_FILE" 2>/dev/null || true
        fi
        [ -s "$RUNNER_CID_FILE" ] || rm -f "$RUNNER_CID_FILE" 2>/dev/null || true
        return "$create_exit"
      fi
      rm -f "$RUNNER_CREATE_ERR_FILE" 2>/dev/null || true

      local active_cid
      active_cid=$(cat "$RUNNER_CID_FILE" 2>/dev/null | tr -d '[:space:]')

      local exec_exit=0
      set +e
      if [ "$stage_name" = "preflight" ]; then
        podman start --attach "$active_cid" 2>&1 | _process_bounded_stream "$PREFLIGHT_DIAG_LOG" "tee"
      else
        podman start --attach "$active_cid" 2>&1 | _process_bounded_stream "$PREFLIGHT_DIAG_LOG" "sink"
      fi
      local -a pipe_status=("${PIPESTATUS[@]}")
      set -e
      local cmd_exit="${pipe_status[0]:-0}"
      local sanitizer_exit="${pipe_status[1]:-0}"

      if [ "$cmd_exit" -ne 0 ]; then
        exec_exit="$cmd_exit"
        if [ "$sanitizer_exit" -ne 0 ]; then
          echo "WARNING: Diagnostic stream processor also failed with exit code ${sanitizer_exit}; preserving command exit code ${cmd_exit}" >&2
        fi
      elif [ "$sanitizer_exit" -ne 0 ]; then
        exec_exit="$sanitizer_exit"
        echo "ERROR: Diagnostic stream processor failed with exit code ${sanitizer_exit}" >&2
      else
        exec_exit=0
      fi

      if [ "$exec_exit" -ne 0 ] && [ "$FIRST_FAILURE_EXIT" -eq 0 ]; then
        FIRST_FAILURE_EXIT="$exec_exit"
      fi

      # Remove container before workspace. Verify ownership before removal.
      if [ -n "$active_cid" ] && podman container exists "$active_cid" 2>/dev/null; then
        local owner_label
        owner_label=$(podman inspect "$active_cid" --format '{{index .Config.Labels "io.s2-assets.invocation-id"}}' 2>/dev/null || true)
        if [ "$owner_label" = "$INVOCATION_ID" ]; then
          local rm_success=1
          if [ "${FOUNDATION_E2E_SIMULATE_CLEANUP_FAIL:-0}" = "1" ]; then
            rm_success=0
          elif ! podman rm -f -t 1 "$active_cid" >/dev/null 2>&1; then
            rm_success=0
          fi
          if [ "$rm_success" -eq 1 ]; then
            rm -f "$RUNNER_CID_FILE" 2>/dev/null || true
          else
            echo "ERROR: Failed to remove runner container ${active_cid}" >&2
            CLEANUP_FAILED=1
            [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT=1
          fi
        else
          echo "ERROR: Container ${active_cid} does not match invocation label; refusing to remove unowned container" >&2
          CLEANUP_FAILED=1
          [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT=1
        fi
      fi

      local stage_exit="$exec_exit"
      if [ "$stage_exit" -eq 0 ] && [ "$CLEANUP_FAILED" -ne 0 ]; then
        stage_exit=1
      fi
      return "$stage_exit"
    }

    # Copy application files to runner workspace, strictly excluding Git, Spec Kit, agent tooling, node_modules
    tar --exclude=".git" \
        --exclude=".agents" \
        --exclude="specs" \
        --exclude=".specify" \
        --exclude="node_modules" \
        --exclude=".multica" \
        --exclude="AGENTS.md" \
        --exclude="*.log" \
        -cf - -C "$REPO_ROOT" . | tar -xf - -C "$RUNNER_WORKSPACE"

    # 9. Run frozen dependency installation inside disposable runner workspace
    echo "Installing frozen dependencies in disposable runner workspace..."
    LOCK_HASH_BEFORE=$(sha256sum "${REPO_ROOT}/pnpm-lock.yaml" | awk '{print $1}')

    if [ "${FOUNDATION_E2E_SIMULATE_FAIL:-}" = "install" ]; then
      FIRST_FAILURE_EXIT=44
      echo "Simulating deliberate failure in install phase (exit code 44)..." >&2
      exit 44
    fi

    _run_runner_stage "install" "" pnpm install --frozen-lockfile
    INSTALL_EXIT=$?

    if [ "$INSTALL_EXIT" -ne 0 ] || [ "$CLEANUP_FAILED" -ne 0 ]; then
      [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT="$INSTALL_EXIT"
      [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT=1
      echo "ERROR: Runner dependency installation failed with exit code ${FIRST_FAILURE_EXIT}" >&2
      exit "$FIRST_FAILURE_EXIT"
    fi

    LOCK_HASH_AFTER=$(sha256sum "${REPO_ROOT}/pnpm-lock.yaml" | awk '{print $1}')
    if [ "$LOCK_HASH_BEFORE" != "$LOCK_HASH_AFTER" ]; then
      FIRST_FAILURE_EXIT=1
      _fail "ERROR: pnpm install altered repository lockfile; frozen lockfile integrity violated"
    fi

    # 10. Execute preflight verification inside runner container attached to application network
    echo "Executing isolated Playwright runtime preflight..."

    if [ "${FOUNDATION_E2E_SIMULATE_FAIL:-}" = "preflight" ]; then
      FIRST_FAILURE_EXIT=45
      echo "Simulating deliberate failure in preflight phase (exit code 45)..." >&2
      exit 45
    fi

    cat <<'PREFLIGHT_EOF' > "${RUNNER_WORKSPACE}/e2e-preflight.mjs"
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireWeb = createRequire('/workspace/apps/web/package.json');

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return '';
  return String(rawUrl).replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:@/[:space:]]+:[^@/[:space:]]+@/g, '$1[REDACTED_AUTH]@');
}

async function runPreflight() {
  console.log("=== Playwright Runtime Preflight Assertions ===");

  // 1. Exact Node runtime version
  const nodeVersion = process.version;
  console.log(`Node version: ${nodeVersion}`);
  if (nodeVersion !== 'v24.21.0') {
    throw new Error(`Node version mismatch: expected v24.21.0, got ${nodeVersion}`);
  }

  // 2. Exact pnpm version
  const pnpmVersion = execSync('pnpm -v', { encoding: 'utf8' }).trim();
  console.log(`pnpm version: ${pnpmVersion}`);
  if (pnpmVersion !== '12.9.1') {
    throw new Error(`pnpm version mismatch: expected 12.9.1, got ${pnpmVersion}`);
  }

  // 3. Playwright package pin
  const webPkg = JSON.parse(fs.readFileSync('/workspace/apps/web/package.json', 'utf8'));
  const declaredPlaywright = webPkg.devDependencies?.['@playwright/test'];
  console.log(`Declared @playwright/test in apps/web: ${declaredPlaywright}`);
  if (declaredPlaywright !== '1.63.0') {
    throw new Error(`Declared @playwright/test mismatch: expected 1.63.0, got ${declaredPlaywright}`);
  }

  const installedPlaywrightPkg = requireWeb('@playwright/test/package.json');
  console.log(`Installed @playwright/test version: ${installedPlaywrightPkg.version}`);
  if (installedPlaywrightPkg.version !== '1.63.0') {
    throw new Error(`Installed @playwright/test mismatch: expected 1.63.0, got ${installedPlaywrightPkg.version}`);
  }

  // 4. Web command discovery
  const testE2eScript = webPkg.scripts?.['test:e2e'];
  console.log(`Web test:e2e command discovered: "${testE2eScript}"`);
  if (testE2eScript !== 'playwright test') {
    throw new Error(`Web test:e2e script mismatch: expected "playwright test", got "${testE2eScript}"`);
  }

  // 5. Config discovery & validation
  const baseURL = process.env.E2E_BASE_URL;
  if (!baseURL) {
    throw new Error("E2E_BASE_URL is not set in container environment");
  }

  const configModule = await import('/workspace/apps/web/playwright.config.ts');
  const config = configModule.default;

  console.log("Playwright config loaded successfully:");
  console.log(`  - testDir: ${config.testDir}`);
  console.log(`  - workers: ${config.workers}`);
  console.log(`  - timeout: ${config.timeout}`);
  console.log(`  - expect.timeout: ${config.expect?.timeout}`);
  console.log(`  - outputDir: ${config.outputDir}`);
  console.log(`  - baseURL: ${sanitizeUrl(config.use?.baseURL)}`);

  if (config.testDir !== './tests/e2e') {
    throw new Error(`config.testDir mismatch: expected './tests/e2e', got '${config.testDir}'`);
  }
  if (config.workers !== 1) {
    throw new Error(`config.workers mismatch: expected 1, got ${config.workers}`);
  }
  if (config.timeout !== 30000) {
    throw new Error(`config.timeout mismatch: expected 30000, got ${config.timeout}`);
  }
  if (config.expect?.timeout !== 5000) {
    throw new Error(`config.expect.timeout mismatch: expected 5000, got ${config.expect?.timeout}`);
  }
  if (config.outputDir !== './test-results') {
    throw new Error(`config.outputDir mismatch: expected './test-results', got '${config.outputDir}'`);
  }
  if (config.use?.baseURL !== 'http://web:5173') {
    throw new Error(`config.use.baseURL mismatch: expected 'http://web:5173', got '${sanitizeUrl(config.use?.baseURL)}'`);
  }

  const projects = config.projects || [];
  const chromiumProject = projects.find(p => p.name === 'chromium');
  if (!chromiumProject) {
    throw new Error("config.projects missing required 'chromium' project");
  }
  console.log("  - projects: verified Chromium project");

  // 6. Chromium executable availability
  const { chromium } = requireWeb('@playwright/test');
  const chromePath = chromium.executablePath();
  console.log(`Chromium executable path: ${chromePath}`);
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chromium executable not found at ${chromePath}`);
  }

  const chromeVersion = execSync(`"${chromePath}" --version`, { encoding: 'utf8' }).trim();
  console.log(`Chromium executable version: ${chromeVersion}`);
  if (!chromeVersion.toLowerCase().includes('chrome')) {
    throw new Error(`Unexpected Chromium version output: ${chromeVersion}`);
  }

  // 7. Runner-to-Web HTTP connectivity
  console.log(`Testing runner-to-Web HTTP connectivity at ${sanitizeUrl(baseURL)}...`);
  const rootRes = await fetch(baseURL);
  console.log(`  GET ${sanitizeUrl(baseURL)} -> HTTP ${rootRes.status}`);
  if (!rootRes.ok) {
    throw new Error(`Failed to reach ${sanitizeUrl(baseURL)}: HTTP status ${rootRes.status}`);
  }

  const loginURL = `${baseURL}/login`;
  console.log(`Testing runner-to-Web HTTP connectivity at ${sanitizeUrl(loginURL)}...`);
  const loginRes = await fetch(loginURL);
  console.log(`  GET ${sanitizeUrl(loginURL)} -> HTTP ${loginRes.status}`);
  if (!loginRes.ok) {
    throw new Error(`Failed to reach ${sanitizeUrl(loginURL)}: HTTP status ${loginRes.status}`);
  }
  const loginBody = await loginRes.text();
  if (!loginBody.includes('<html') && !loginBody.includes('<!DOCTYPE')) {
    throw new Error(`Response from ${sanitizeUrl(loginURL)} does not appear to be HTML entrypoint`);
  }
  console.log("  Runner-to-Web HTTP connectivity successfully verified (HTML entrypoint confirmed).");

  // 8. Verify browser test execution boundary
  const authSpecPath = '/workspace/apps/web/tests/e2e/auth.spec.ts';
  const hasAuthSpec = fs.existsSync(authSpecPath);
  console.log(`Browser test suite present: ${hasAuthSpec} (${authSpecPath})`);
  console.log("Preflight boundary confirmed: runtime checks only; no browser tests or authentication flows executed.");
  console.log("=== Playwright Runtime Preflight Succeeded ===");
}

runPreflight().catch(err => {
  console.error("PREFLIGHT ERROR:", err.message);
  process.exit(1);
});
PREFLIGHT_EOF

    _run_runner_stage "preflight" "$APP_NETWORK" node --experimental-strip-types /workspace/e2e-preflight.mjs
    PREFLIGHT_EXIT=$?

    if [ "$PREFLIGHT_EXIT" -ne 0 ] || [ "$CLEANUP_FAILED" -ne 0 ]; then
      [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT="$PREFLIGHT_EXIT"
      [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT=1
      echo "ERROR: Isolated Playwright runtime preflight failed with exit code ${FIRST_FAILURE_EXIT}" >&2
      exit "$FIRST_FAILURE_EXIT"
    fi

    if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
      echo "Isolated Playwright runtime preflight completed successfully."
      exit 0
    fi

    # 11. If not preflight-only, run full E2E test action (only reachable when T033 authorized and auth.spec.ts exists)
    echo "Running Playwright E2E browser tests..."
    _run_runner_stage "test" "$APP_NETWORK" pnpm --filter web test:e2e
    E2E_EXIT=$?

    if [ "$E2E_EXIT" -ne 0 ] || [ "$CLEANUP_FAILED" -ne 0 ]; then
      [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT="$E2E_EXIT"
      [ "$FIRST_FAILURE_EXIT" -eq 0 ] && FIRST_FAILURE_EXIT=1
      echo "ERROR: E2E browser test run failed with exit code ${FIRST_FAILURE_EXIT}" >&2
      exit "$FIRST_FAILURE_EXIT"
    fi

    echo "E2E verification completed successfully."
    exit 0
    ;;
  *)
    _fail "ERROR: Unknown action '$ACTION'. Authorized actions: none (provider preflight), 'prepare', 'test-identity', 'http-smoke', or 'e2e'."
    ;;
esac
