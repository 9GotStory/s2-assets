#!/usr/bin/env bash
# scripts/verify-foundation.sh — Fixed-purpose verification runner for Application Foundation
# Modes: 'targeted' (local disposable lifecycle & signal verification) or 'integration-ci' (safe private-endpoint CI integration)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

_fail() {
  echo "$1" >&2
  exit 1
}

# --- Shared Validation Helpers ---

_validate_foundation_env_file() {
  if [ -z "${FOUNDATION_ENV_FILE:-}" ]; then
    _fail "ERROR: FOUNDATION_ENV_FILE is not set. Specify the path to a trusted private environment file."
  fi

  case "$FOUNDATION_ENV_FILE" in
    /*) ;;
    *) _fail "ERROR: FOUNDATION_ENV_FILE must be an absolute path: ${FOUNDATION_ENV_FILE}" ;;
  esac

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

  if [ ! -f "$FOUNDATION_ENV_FILE" ]; then
    _fail "ERROR: FOUNDATION_ENV_FILE not found: ${FOUNDATION_ENV_FILE}"
  fi

  FILE_MODE=$(stat -c "%a" "$FOUNDATION_ENV_FILE" 2>/dev/null || stat -f "%OLp" "$FOUNDATION_ENV_FILE" 2>/dev/null || true)
  if [ -n "$FILE_MODE" ]; then
    FILE_TAIL="${FILE_MODE: -2}"
    if [ "$FILE_TAIL" != "00" ]; then
      _fail "ERROR: Insecure permissions on ${FOUNDATION_ENV_FILE}: mode must be 600 or 400 (got ${FILE_MODE})"
    fi
  fi

  ENV_DIR=$(dirname "$FOUNDATION_ENV_FILE")
  DIR_MODE=$(stat -c "%a" "$ENV_DIR" 2>/dev/null || stat -f "%OLp" "$ENV_DIR" 2>/dev/null || true)
  if [ -n "$DIR_MODE" ]; then
    DIR_TAIL="${DIR_MODE: -2}"
    if [ "$DIR_TAIL" != "00" ]; then
      _fail "ERROR: Insecure permissions on directory ${ENV_DIR}: mode must be 700 (got ${DIR_MODE})"
    fi
  fi

  set -a
  # shellcheck disable=SC1090
  source "$FOUNDATION_ENV_FILE"
  set +a

  if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
    _fail "ERROR: COMPOSE_PROJECT_NAME is required in ${FOUNDATION_ENV_FILE}"
  fi
  if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^s2_[a-z0-9_-]+$ ]]; then
    _fail "ERROR: COMPOSE_PROJECT_NAME must begin with 's2_' and be lowercase alphanumeric: ${COMPOSE_PROJECT_NAME}"
  fi
  if [ "$COMPOSE_PROJECT_NAME" = "s2-assets" ] || [ "$COMPOSE_PROJECT_NAME" = "s2-assets-dev" ]; then
    _fail "ERROR: COMPOSE_PROJECT_NAME cannot use shared project names: ${COMPOSE_PROJECT_NAME}"
  fi

  if [ -z "${POSTGRES_DB:-}" ]; then
    _fail "ERROR: POSTGRES_DB is required in ${FOUNDATION_ENV_FILE}"
  fi
  if [[ ! "$POSTGRES_DB" =~ ^s2_foundation_[a-zA-Z0-9_]+$ ]]; then
    _fail "ERROR: POSTGRES_DB must begin with 's2_foundation_': ${POSTGRES_DB}"
  fi
  if [ "$POSTGRES_DB" = "s2_foundation_s2_assets" ] || [ "$POSTGRES_DB" = "s2_assets" ] || [ "$POSTGRES_DB" = "postgres" ]; then
    _fail "ERROR: POSTGRES_DB cannot use default or shared database name: ${POSTGRES_DB}"
  fi

  if [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_PASSWORD:-}" ] || [ -z "${COOKIE_SECRET:-}" ]; then
    _fail "ERROR: POSTGRES_USER, POSTGRES_PASSWORD, and COOKIE_SECRET are required in ${FOUNDATION_ENV_FILE}"
  fi

  export API_HOST_PORT="${API_HOST_PORT:-3000}"
  export WEB_HOST_PORT="${WEB_HOST_PORT:-5173}"
}

_validate_port_availability() {
  local port="$1"
  local name="$2"

  if command -v ss >/dev/null 2>&1; then
    if ss -tlpn 2>/dev/null | grep -Eq "(127\.0\.0\.1|0\.0\.0\.0|\*):${port}[[:space:]]"; then
      _fail "ERROR: Port ${port} (${name}) is already occupied on loopback interface"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -i "TCP@127.0.0.1:${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      _fail "ERROR: Port ${port} (${name}) is already occupied on loopback interface"
    fi
  fi
}

_validate_endpoint_socket_guards() {
  local sock="$1"
  local expected_dir="$2"

  if [ -z "$sock" ]; then
    _fail "ERROR: Endpoint socket path is empty"
  fi

  if [ ! -S "$sock" ]; then
    _fail "ERROR: Endpoint socket is missing or not a socket: ${sock}"
  fi

  if [ -L "$sock" ]; then
    _fail "ERROR: Endpoint socket must not be a symlink: ${sock}"
  fi

  local sock_owner
  sock_owner=$(stat -c "%u" "$sock" 2>/dev/null || stat -f "%u" "$sock" 2>/dev/null || echo "unknown")
  local current_uid
  current_uid=$(id -u)
  if [ "$sock_owner" != "$current_uid" ]; then
    _fail "ERROR: Endpoint socket foreign ownership detected: owner=${sock_owner}, expected=${current_uid}"
  fi

  local canonical_sock
  canonical_sock=$(realpath "$sock" 2>/dev/null || readlink -f "$sock" 2>/dev/null || echo "$sock")
  case "$canonical_sock" in
    /run/user/*/podman/podman.sock|/run/podman/podman.sock|/var/run/docker.sock)
      _fail "ERROR: Shared or default podman socket path prohibited: ${canonical_sock}"
      ;;
  esac

  if [ -n "$expected_dir" ]; then
    local canonical_dir
    canonical_dir=$(realpath "$expected_dir" 2>/dev/null || readlink -f "$expected_dir" 2>/dev/null || echo "$expected_dir")
    case "$canonical_sock" in
      "${canonical_dir}"/*) ;;
      *) _fail "ERROR: Endpoint socket ${canonical_sock} is outside private run directory ${canonical_dir}" ;;
    esac
  fi
}

# --- Mode: targeted ---
_run_targeted() {
  echo "=== Running Fixed-Purpose Verification: Mode 'targeted' ==="

  # Phase 1: Authority & Baseline
  echo "--- Phase 1: Authority and Baseline Validation ---"
  _validate_foundation_env_file

  if [ -z "${FOUNDATION_VERIFY_RUN_ID:-}" ]; then
    _fail "ERROR: FOUNDATION_VERIFY_RUN_ID is required for mode 'targeted'"
  fi
  if [[ ! "$FOUNDATION_VERIFY_RUN_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    _fail "ERROR: FOUNDATION_VERIFY_RUN_ID must be alphanumeric with hyphens or underscores: ${FOUNDATION_VERIFY_RUN_ID}"
  fi

  STATE_FILE="${ENV_DIR}/.verify-${FOUNDATION_VERIFY_RUN_ID}.json"
  if [ -f "$STATE_FILE" ]; then
    local prev_status
    prev_status=$(grep -o '"status":"[^"]*"' "$STATE_FILE" 2>/dev/null | cut -d'"' -f4 || true)
    if [ "$prev_status" = "failed" ]; then
      _fail "ERROR: Run ID ${FOUNDATION_VERIFY_RUN_ID} previously recorded as failed. Reuse of failed run is refused."
    fi
  fi

  # Record initial running state
  cat <<EOF > "$STATE_FILE"
{"run_id":"${FOUNDATION_VERIFY_RUN_ID}","mode":"targeted","status":"running","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
  chmod 600 "$STATE_FILE"

  FIRST_FAILURE=0
  CLEANUP_FAILURE=0

  _record_failure() {
    local code="${1:-1}"
    if [ "$FIRST_FAILURE" -eq 0 ]; then
      FIRST_FAILURE="$code"
      cat <<EOF > "$STATE_FILE"
{"run_id":"${FOUNDATION_VERIFY_RUN_ID}","mode":"targeted","status":"failed","exit_code":${FIRST_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$STATE_FILE"
    fi
  }

  _cleanup_targeted() {
    local exit_code="$?"
    trap - EXIT INT TERM

    if [ "$exit_code" -ne 0 ] && [ "$FIRST_FAILURE" -eq 0 ]; then
      _record_failure "$exit_code"
    fi

    echo "--- Phase 5: Exact-Owned Cleanup ---"
    if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "${FOUNDATION_ENV_FILE:-}" ]; then
      echo "Tearing down project containers for ${COMPOSE_PROJECT_NAME} (preserving data volume)..."
      if ! podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" down; then
        echo "ERROR: podman compose down encountered an error!" >&2
        CLEANUP_FAILURE=1
      fi

      local rem_c
      rem_c=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}" --format '{{.Names}}' 2>/dev/null || true)
      if [ -n "$rem_c" ]; then
        echo "ERROR: Project containers remain after teardown: ${rem_c}" >&2
        CLEANUP_FAILURE=1
      fi

      local preserved_vol
      preserved_vol=$(podman volume ls --filter "name=${COMPOSE_PROJECT_NAME}" --format '{{.Name}}' 2>/dev/null || true)
      if [ -n "$preserved_vol" ]; then
        echo "Preserved project volume: ${preserved_vol}"
      fi
    fi

    if [ "$FIRST_FAILURE" -ne 0 ]; then
      echo "Targeted run exiting with preserved first failure code: ${FIRST_FAILURE}" >&2
      exit "$FIRST_FAILURE"
    fi

    if [ "$CLEANUP_FAILURE" -ne 0 ]; then
      echo "ERROR: Cleanup failed or uncertain; exiting with 1" >&2
      exit 1
    fi

    exit 0
  }

  trap '_cleanup_targeted' EXIT
  trap '_record_failure 130; exit 130' INT
  trap '_record_failure 143; exit 143' TERM

  # Phase 2: Prerequisites & Ownership
  echo "--- Phase 2: Prerequisites and Ownership Validation ---"
  local provider="${PODMAN_COMPOSE_PROVIDER:-podman-compose}"
  if ! command -v "$provider" >/dev/null 2>&1; then
    _record_failure 1
    _fail "ERROR: Compose provider '${provider}' is not available"
  fi
  if ! command -v podman >/dev/null 2>&1 || ! command -v podman-compose >/dev/null 2>&1; then
    _record_failure 1
    _fail "ERROR: podman or podman-compose not available"
  fi

  local clean_version
  clean_version=$(podman compose version 2>&1 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' || true)
  if ! echo "${clean_version}" | grep -Eq "^podman-compose version 1\.6\.0[[:space:]]*$"; then
    _record_failure 1
    _fail "ERROR: Requires podman-compose 1.6.0"
  fi

  # Injected prerequisite failure hook for testing
  if [ "${FOUNDATION_VERIFY_INJECT_FAIL:-}" = "prerequisite" ]; then
    echo "Simulating injected prerequisite failure (code 47)..." >&2
    _record_failure 47
    exit 47
  fi

  _validate_port_availability "$API_HOST_PORT" "API"
  _validate_port_availability "$WEB_HOST_PORT" "Web"

  # Phase 3: Affected Verification (Lifecycle & Signal Delivery)
  echo "--- Phase 3: Affected Verification (Startup, Signals & Readiness) ---"

  echo "Starting PostgreSQL container for ${COMPOSE_PROJECT_NAME}..."
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d postgres

  local pg_ready=0
  for attempt in {1..30}; do
    if podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t 2 >/dev/null 2>&1; then
      echo "PostgreSQL service ready (attempt ${attempt})."
      pg_ready=1
      break
    fi
    sleep 1
  done
  if [ "$pg_ready" -ne 1 ]; then
    _record_failure 1
    _fail "ERROR: PostgreSQL service failed to become ready within timeout"
  fi

  echo "Starting API and Web containers..."
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d api web

  local api_h_ready=0 api_r_ready=0 web_l_ready=0 web_d_ready=0 web_p_ready=0
  for attempt in {1..40}; do
    if [ "$api_h_ready" -eq 0 ]; then
      if [ "$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_HOST_PORT}/health" || true)" = "200" ]; then
        api_h_ready=1
      fi
    fi
    if [ "$api_r_ready" -eq 0 ]; then
      if [ "$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_HOST_PORT}/ready" || true)" = "200" ]; then
        api_r_ready=1
      fi
    fi
    if [ "$web_l_ready" -eq 0 ]; then
      if [ "$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/login" || true)" = "200" ]; then
        web_l_ready=1
      fi
    fi
    if [ "$web_d_ready" -eq 0 ]; then
      if [ "$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/dashboard" || true)" = "200" ]; then
        web_d_ready=1
      fi
    fi
    if [ "$web_p_ready" -eq 0 ]; then
      if [ "$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/auth/session-check" || true)" = "401" ]; then
        web_p_ready=1
      fi
    fi

    if [ "$api_h_ready" -eq 1 ] && [ "$api_r_ready" -eq 1 ] && [ "$web_l_ready" -eq 1 ] && [ "$web_d_ready" -eq 1 ] && [ "$web_p_ready" -eq 1 ]; then
      echo "All service endpoints verified ready (attempt ${attempt}):"
      echo "  - API /health: 200"
      echo "  - API /ready: 200"
      echo "  - Web /login: 200"
      echo "  - Web /dashboard: 200"
      echo "  - Web proxy /auth/session-check: 401"
      break
    fi
    sleep 1
  done

  if [ "$api_h_ready" -ne 1 ] || [ "$api_r_ready" -ne 1 ] || [ "$web_l_ready" -ne 1 ] || [ "$web_d_ready" -ne 1 ] || [ "$web_p_ready" -ne 1 ]; then
    _record_failure 1
    _fail "ERROR: Readiness probes timed out"
  fi

  echo "Testing graceful shutdown and signal delivery..."
  local stop_start stop_end stop_duration
  stop_start=$(date +%s%N 2>/dev/null || date +%s)
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" stop api web
  stop_end=$(date +%s%N 2>/dev/null || date +%s)

  # Check logs for graceful shutdown
  local api_logs
  api_logs=$(podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" logs api 2>&1 || true)
  if echo "$api_logs" | grep -q "Received termination signal, starting graceful shutdown" && echo "$api_logs" | grep -q "Graceful shutdown completed"; then
    echo "Verified: API received SIGTERM and executed graceful shutdown handlers."
  else
    echo "WARNING: API logs did not capture expected shutdown message"
  fi

  local api_exit web_exit
  api_exit=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*api" --format '{{.ExitCode}}' 2>/dev/null | head -n 1 || echo "unknown")
  web_exit=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*web" --format '{{.ExitCode}}' 2>/dev/null | head -n 1 || echo "unknown")
  echo "Container stop exit codes: api=${api_exit}, web=${web_exit}"
  if [ "$api_exit" = "137" ] || [ "$web_exit" = "137" ]; then
    _record_failure 1
    _fail "ERROR: Container was terminated via forced SIGKILL (code 137)!"
  fi

  echo "Testing restart reaching positive readiness..."
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" start api web

  local restart_ready=0
  for attempt in {1..30}; do
    local a_code w_code
    a_code=$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_HOST_PORT}/health" || true)
    w_code=$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/login" || true)
    if [ "$a_code" = "200" ] && [ "$w_code" = "200" ]; then
      restart_ready=1
      echo "Restarted services verified ready (attempt ${attempt})."
      break
    fi
    sleep 1
  done
  if [ "$restart_ready" -ne 1 ]; then
    _record_failure 1
    _fail "ERROR: Services failed to become ready after restart"
  fi

  # Phase 4: Evidence Persistence
  echo "--- Phase 4: Recording Evidence ---"
  cat <<EOF > "$STATE_FILE"
{"run_id":"${FOUNDATION_VERIFY_RUN_ID}","mode":"targeted","status":"passed","api_exit":"${api_exit}","web_exit":"${web_exit}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
  chmod 600 "$STATE_FILE"
  echo "Targeted verification completed successfully."
}

# --- Mode: integration-ci ---
_run_integration_ci() {
  echo "=== Running Fixed-Purpose Verification: Mode 'integration-ci' ==="

  local RUN_ID="ci_integ_${GITHUB_RUN_ID:-$$}"
  local RUN_DIR="/tmp/s2_integ_sock_${RUN_ID}"
  local ENDPOINT_SOCK="${RUN_DIR}/podman.sock"
  local ENDPOINT_PID=""
  local BASELINE_FILE="${RUN_DIR}/baseline_containers.txt"
  local CURRENT_FILE="${RUN_DIR}/current_containers.txt"

  rm -rf "$RUN_DIR"
  mkdir -m 700 "$RUN_DIR"

  FIRST_FAILURE=0
  CLEANUP_FAILURE=0

  _record_ci_failure() {
    local code="${1:-1}"
    if [ "$FIRST_FAILURE" -eq 0 ]; then
      FIRST_FAILURE="$code"
    fi
  }

  _cleanup_integration_ci() {
    local exit_code="$?"
    trap - EXIT INT TERM

    if [ "$exit_code" -ne 0 ] && [ "$FIRST_FAILURE" -eq 0 ]; then
      _record_ci_failure "$exit_code"
    fi

    echo "--- Phase 5: Exact-Owned Cleanup (integration-ci) ---"

    # 1. Remove exact test-owned containers
    if [ -f "$BASELINE_FILE" ] && command -v podman >/dev/null 2>&1; then
      podman ps -aq --no-trunc > "$CURRENT_FILE" 2>/dev/null || true
      local new_c
      new_c=$(grep -v -F -f "$BASELINE_FILE" "$CURRENT_FILE" 2>/dev/null || true)
      if [ -n "$new_c" ]; then
        echo "Removing test-owned containers:"
        echo "$new_c"
        for cid in $new_c; do
          if ! podman rm -f "$cid" >/dev/null 2>&1; then
            echo "ERROR: Failed to remove test container $cid" >&2
            CLEANUP_FAILURE=1
          fi
        done
      fi
    fi

    # 2. Terminate private endpoint PID cleanly
    if [ -n "$ENDPOINT_PID" ]; then
      if kill -0 "$ENDPOINT_PID" 2>/dev/null; then
        echo "Stopping private rootless endpoint PID $ENDPOINT_PID..."
        kill "$ENDPOINT_PID" 2>/dev/null || true
        for _ in {1..10}; do
          if ! kill -0 "$ENDPOINT_PID" 2>/dev/null; then
            break
          fi
          sleep 0.5
        done
        if kill -0 "$ENDPOINT_PID" 2>/dev/null; then
          kill -9 "$ENDPOINT_PID" 2>/dev/null || true
        fi
      fi
    fi

    # 3. Remove temporary endpoint directory
    rm -rf "$RUN_DIR"

    if [ "$FIRST_FAILURE" -ne 0 ]; then
      echo "Integration-CI exiting with preserved first failure code: ${FIRST_FAILURE}" >&2
      exit "$FIRST_FAILURE"
    fi

    if [ "$CLEANUP_FAILURE" -ne 0 ]; then
      echo "ERROR: Cleanup failed or uncertain; exiting with 1" >&2
      exit 1
    fi

    exit 0
  }

  trap '_cleanup_integration_ci' EXIT
  trap '_record_ci_failure 130; exit 130' INT
  trap '_record_ci_failure 143; exit 143' TERM

  # Phase 1 & 2: Setup Private Owned Endpoint & Mount Guards
  echo "--- Phase 1 & 2: Private Endpoint Setup & Fail-Closed Mount Guards ---"
  podman system service --time=0 "unix://${ENDPOINT_SOCK}" &
  ENDPOINT_PID=$!

  local sock_ready=0
  for _ in {1..30}; do
    if [ -S "$ENDPOINT_SOCK" ]; then
      sock_ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$sock_ready" -ne 1 ]; then
    _record_ci_failure 1
    _fail "ERROR: Private endpoint socket failed to initialize: ${ENDPOINT_SOCK}"
  fi
  chmod 600 "$ENDPOINT_SOCK"

  # Enforce fail-closed socket guards
  _validate_endpoint_socket_guards "$ENDPOINT_SOCK" "$RUN_DIR"

  # Bounded ping/info verification
  if ! curl -s --connect-timeout 2 --max-time 3 --unix-socket "$ENDPOINT_SOCK" http://d/v5.0.0/libpod/info >/dev/null 2>&1; then
    _record_ci_failure 1
    _fail "ERROR: Private endpoint socket connection verification failed"
  fi
  echo "Private owned endpoint verified: ${ENDPOINT_SOCK} (PID ${ENDPOINT_PID})"

  # Build containerized integration runner without fallback
  echo "Building containerized integration runner..."
  if ! podman image exists s2-assets-dev:ci 2>/dev/null; then
    echo "Building base development tooling image s2-assets-dev:ci..."
    podman build -f "${REPO_ROOT}/deploy/podman/dev.Containerfile" -t s2-assets-dev:ci "${REPO_ROOT}"
  fi
  cat << 'EOF' | podman build -t s2-assets-integration:ci -f - "${REPO_ROOT}"
FROM s2-assets-dev:ci
USER root
RUN apk add --no-cache podman curl bash
RUN printf '#!/bin/sh\nif [ -z "${CONTAINER_HOST:-}" ]; then echo "ERROR: CONTAINER_HOST is required; no fallback permitted" >&2; exit 1; fi\nexec /usr/bin/podman --remote --url "${CONTAINER_HOST}" "$@"\n' > /usr/local/bin/podman && chmod +x /usr/local/bin/podman
EOF

  # Record baseline containers
  podman ps -aq --no-trunc > "$BASELINE_FILE"

  # Phase 3: Run integration tests with safe mount contract (NO :z or :Z on socket)
  echo "--- Phase 3: Running Integration Tests via Safe Private Endpoint ---"
  podman run --name s2_integration_runner --rm \
    --network=host \
    --userns=keep-id \
    -u 1001:1001 \
    --security-opt label=disable \
    -v "${REPO_ROOT}:/work:z" \
    -v "${ENDPOINT_SOCK}:${ENDPOINT_SOCK}" \
    -w /work \
    -e DOCKER_HOST="unix://${ENDPOINT_SOCK}" \
    -e CONTAINER_HOST="unix://${ENDPOINT_SOCK}" \
    -e TESTCONTAINERS_RYUK_DISABLED="true" \
    -e TESTCONTAINERS_HOST_OVERRIDE="127.0.0.1" \
    -e CI="true" \
    s2-assets-integration:ci \
    pnpm --filter api exec vitest run tests/integration

  echo "Integration tests completed successfully."
}

if ! (return 0 2>/dev/null); then
  MODE="${1:-}"
  if [ -z "$MODE" ]; then
    echo "ERROR: Mode required. Authorized modes: 'targeted' or 'integration-ci'." >&2
    exit 1
  fi

  case "$MODE" in
    targeted)
      _run_targeted
      ;;
    integration-ci)
      _run_integration_ci
      ;;
    *)
      _fail "ERROR: Unknown mode '$MODE'. Authorized modes: 'targeted' or 'integration-ci'."
      ;;
  esac
fi
