#!/usr/bin/env bash
# scripts/verify-foundation.sh — Fixed-purpose verification runner for Application Foundation
# Modes: 'targeted' (local disposable lifecycle & signal verification) or 'integration-ci' (safe private-endpoint CI integration)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

APPROVED_BASELINE_SHA="98be44f1a85ed1cc7d786ebbd03566cb8d5bc5e6"
APPROVED_PARENT_SHA="558e4b6fdbed36d109cfcbc796e63e6f918bba2d"

# Script-level tracking variables for traps and receipts
CI_RUN_ID=""
CI_RUN_DIR=""
CI_RUN_DIR_CREATED=0
CI_RUN_DIR_INODE=""
CI_ENDPOINT_SOCK=""
CI_ENDPOINT_PID=""
CI_BASELINE_FILE=""
CI_CURRENT_FILE=""
CI_RUNNER_NAME=""
CI_STATE_FILE=""
CI_FIRST_FAILURE=0
CI_CLEANUP_FAILURE=0
CI_MUTATION_STARTED=0
CI_VERIFIED=0
CI_REUSE_REFUSED=0

TARGETED_RUN_ID=""
TARGETED_STATE_FILE=""
TARGETED_MUTATION_STARTED=0
TARGETED_FIRST_FAILURE=0
TARGETED_CLEANUP_FAILURE=0
TARGETED_PHASE4_PASSED=0
TARGETED_API_EXIT=""
TARGETED_WEB_EXIT=""
TARGETED_REUSE_REFUSED=0

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

  local canonical_repo canonical_env lexical_env
  canonical_repo=$(realpath "$REPO_ROOT" 2>/dev/null || readlink -f "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")
  canonical_env=$(realpath "$FOUNDATION_ENV_FILE" 2>/dev/null || readlink -f "$FOUNDATION_ENV_FILE" 2>/dev/null || echo "$FOUNDATION_ENV_FILE")
  lexical_env=$(realpath -s "$FOUNDATION_ENV_FILE" 2>/dev/null || echo "$FOUNDATION_ENV_FILE")

  case "$FOUNDATION_ENV_FILE" in
    "${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
      ;;
  esac
  case "$lexical_env" in
    "${canonical_repo}"/*|"${canonical_repo}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
      ;;
  esac
  case "$canonical_env" in
    "${canonical_repo}"/*|"${canonical_repo}"|"${REPO_ROOT}"/*|"${REPO_ROOT}")
      _fail "ERROR: FOUNDATION_ENV_FILE must reside outside repository checkout: ${FOUNDATION_ENV_FILE}"
      ;;
  esac

  if [ ! -f "$FOUNDATION_ENV_FILE" ]; then
    _fail "ERROR: FOUNDATION_ENV_FILE not found: ${FOUNDATION_ENV_FILE}"
  fi

  local file_mode file_tail
  file_mode=$(stat -c "%a" "$FOUNDATION_ENV_FILE" 2>/dev/null || stat -f "%OLp" "$FOUNDATION_ENV_FILE" 2>/dev/null || true)
  if [ -n "$file_mode" ]; then
    file_tail="${file_mode: -2}"
    if [ "$file_tail" != "00" ]; then
      _fail "ERROR: Insecure permissions on ${FOUNDATION_ENV_FILE}: mode must be 600 or 400 (got ${file_mode})"
    fi
  fi

  ENV_DIR=$(dirname "$FOUNDATION_ENV_FILE")
  local dir_mode dir_tail
  dir_mode=$(stat -c "%a" "$ENV_DIR" 2>/dev/null || stat -f "%OLp" "$ENV_DIR" 2>/dev/null || true)
  if [ -n "$dir_mode" ]; then
    dir_tail="${dir_mode: -2}"
    if [ "$dir_tail" != "00" ]; then
      _fail "ERROR: Insecure permissions on directory ${ENV_DIR}: mode must be 700 (got ${dir_mode})"
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
    local ss_out ss_code=0
    ss_out=$(ss -tlpn 2>&1) || ss_code=$?
    if [ "$ss_code" -ne 0 ]; then
      _record_targeted_failure 1
      _fail "ERROR: Port inspection failed: 'ss' exited with code ${ss_code}: ${ss_out}"
    fi
    if echo "$ss_out" | grep -Eq "(127\.0\.0\.1|0\.0\.0\.0|\*):${port}[[:space:]]"; then
      _record_targeted_failure 1
      _fail "ERROR: Port ${port} (${name}) is already occupied on loopback interface"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    local lsof_out lsof_code=0
    lsof_out=$(lsof -i "TCP@127.0.0.1:${port}" -sTCP:LISTEN 2>&1) || lsof_code=$?
    if [ "$lsof_code" -eq 0 ]; then
      _record_targeted_failure 1
      _fail "ERROR: Port ${port} (${name}) is already occupied on loopback interface"
    elif [ "$lsof_code" -ne 1 ]; then
      _record_targeted_failure 1
      _fail "ERROR: Port inspection failed: 'lsof' exited with code ${lsof_code}: ${lsof_out}"
    fi
  else
    _record_targeted_failure 1
    _fail "ERROR: Neither 'ss' nor 'lsof' is available to inspect port availability; failing closed"
  fi
}

_validate_endpoint_socket_guards() {
  local sock="$1"
  local expected_dir="${2:-}"

  if [ -z "$sock" ]; then
    _fail "ERROR: Endpoint socket path is empty"
  fi

  if [ ! -S "$sock" ]; then
    _fail "ERROR: Endpoint socket is missing or not a socket: ${sock}"
  fi

  if [ -L "$sock" ]; then
    _fail "ERROR: Endpoint socket must not be a symlink: ${sock}"
  fi

  local current_uid
  current_uid=$(id -u)

  local sock_owner sock_st=0
  sock_owner=$(stat -c "%u" "$sock" 2>/dev/null || stat -f "%u" "$sock" 2>/dev/null) || sock_st=$?
  if [ "$sock_st" -ne 0 ] || [ -z "$sock_owner" ] || [ "$sock_owner" != "$current_uid" ]; then
    _fail "ERROR: Endpoint socket foreign ownership detected: owner=${sock_owner:-unknown}, expected=${current_uid}"
  fi

  local sock_mode sock_mode_st=0
  sock_mode=$(stat -c "%a" "$sock" 2>/dev/null || stat -f "%OLp" "$sock" 2>/dev/null) || sock_mode_st=$?
  if [ "$sock_mode_st" -ne 0 ] || [ -z "$sock_mode" ]; then
    _fail "ERROR: Endpoint socket permissions inspection failed: ${sock}"
  fi
  local sock_tail="${sock_mode: -2}"
  if [ "$sock_tail" != "00" ]; then
    _fail "ERROR: Insecure permissions on socket ${sock}: mode must be 600 (got ${sock_mode})"
  fi

  local canonical_sock
  canonical_sock=$(realpath "$sock" 2>/dev/null || readlink -f "$sock" 2>/dev/null || true)
  if [ -z "$canonical_sock" ]; then
    _fail "ERROR: Failed to canonicalize socket path: ${sock}"
  fi
  case "$canonical_sock" in
    /run/user/*/podman/podman.sock|/run/podman/podman.sock|/var/run/docker.sock)
      _fail "ERROR: Shared or default podman socket path prohibited: ${canonical_sock}"
      ;;
  esac

  local sock_dir
  sock_dir=$(dirname "$canonical_sock")
  if [ -L "$sock_dir" ]; then
    _fail "ERROR: Socket parent directory must not be a symlink: ${sock_dir}"
  fi

  local dir_owner dir_st=0
  dir_owner=$(stat -c "%u" "$sock_dir" 2>/dev/null || stat -f "%u" "$sock_dir" 2>/dev/null) || dir_st=$?
  if [ "$dir_st" -ne 0 ] || [ -z "$dir_owner" ] || [ "$dir_owner" != "$current_uid" ]; then
    _fail "ERROR: Socket parent directory foreign ownership detected: owner=${dir_owner:-unknown}, expected=${current_uid}"
  fi

  local dir_mode dir_mode_st=0
  dir_mode=$(stat -c "%a" "$sock_dir" 2>/dev/null || stat -f "%OLp" "$sock_dir" 2>/dev/null) || dir_mode_st=$?
  if [ "$dir_mode_st" -ne 0 ] || [ -z "$dir_mode" ]; then
    _fail "ERROR: Socket parent directory permissions inspection failed: ${sock_dir}"
  fi
  local dir_tail="${dir_mode: -2}"
  if [ "$dir_tail" != "00" ]; then
    _fail "ERROR: Insecure permissions on socket directory ${sock_dir}: mode must be 700 (got ${dir_mode})"
  fi

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

_record_targeted_failure() {
  local code="${1:-1}"
  if [ "${TARGETED_REUSE_REFUSED:-0}" -eq 1 ]; then
    return
  fi
  if [ "$TARGETED_FIRST_FAILURE" -eq 0 ]; then
    TARGETED_FIRST_FAILURE="$code"
    if [ -n "${TARGETED_STATE_FILE:-}" ]; then
      cat <<EOF > "$TARGETED_STATE_FILE"
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","exit_code":${TARGETED_FIRST_FAILURE},"cleanup_failure":${TARGETED_CLEANUP_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$TARGETED_STATE_FILE"
    fi
  fi
}

_cleanup_targeted() {
  local exit_code="$?"
  trap - EXIT INT TERM

  if [ "${TARGETED_REUSE_REFUSED:-0}" -eq 1 ]; then
    exit "$exit_code"
  fi

  if [ "$exit_code" -ne 0 ] && [ "$TARGETED_FIRST_FAILURE" -eq 0 ]; then
    _record_targeted_failure "$exit_code"
  fi

  echo "--- Phase 5: Exact-Owned Cleanup ---"
  if [ "$TARGETED_MUTATION_STARTED" -eq 1 ] && [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "${FOUNDATION_ENV_FILE:-}" ]; then
    echo "Tearing down project containers for ${COMPOSE_PROJECT_NAME} (preserving data volume)..."
    if ! podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" down; then
      echo "ERROR: podman compose down encountered an error!" >&2
      TARGETED_CLEANUP_FAILURE=1
    fi

    local rem_c
    rem_c=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}" --format '{{.Names}}' 2>/dev/null || true)
    if [ -n "$rem_c" ]; then
      echo "ERROR: Project containers remain after teardown: ${rem_c}" >&2
      TARGETED_CLEANUP_FAILURE=1
    fi

    local preserved_vol
    preserved_vol=$(podman volume ls --filter "name=${COMPOSE_PROJECT_NAME}" --format '{{.Name}}' 2>/dev/null || true)
    if [ -n "$preserved_vol" ]; then
      echo "Preserved project volume: ${preserved_vol}"
    fi
  else
    echo "No targeted mutations were started; skipping container teardown."
  fi

  # Record final durable state
  if [ "${TARGETED_REUSE_REFUSED:-0}" -eq 0 ] && [ -n "${TARGETED_STATE_FILE:-}" ]; then
    if [ "$TARGETED_FIRST_FAILURE" -eq 0 ] && [ "$TARGETED_CLEANUP_FAILURE" -eq 0 ] && [ "$TARGETED_PHASE4_PASSED" -eq 1 ]; then
      cat <<EOF > "$TARGETED_STATE_FILE"
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"passed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","api_exit":"${TARGETED_API_EXIT}","web_exit":"${TARGETED_WEB_EXIT}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$TARGETED_STATE_FILE"
    else
      local final_code="$TARGETED_FIRST_FAILURE"
      if [ "$final_code" -eq 0 ]; then final_code=1; fi
      cat <<EOF > "$TARGETED_STATE_FILE"
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","exit_code":${final_code},"cleanup_failure":${TARGETED_CLEANUP_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$TARGETED_STATE_FILE"
    fi
  fi

  if [ "$TARGETED_FIRST_FAILURE" -ne 0 ]; then
    echo "Targeted run exiting with preserved first failure code: ${TARGETED_FIRST_FAILURE}" >&2
    exit "$TARGETED_FIRST_FAILURE"
  fi

  if [ "$TARGETED_CLEANUP_FAILURE" -ne 0 ]; then
    echo "ERROR: Cleanup failed or uncertain; exiting with 1" >&2
    exit 1
  fi

  exit 0
}

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

  TARGETED_RUN_ID="$FOUNDATION_VERIFY_RUN_ID"
  TARGETED_STATE_FILE="${ENV_DIR}/.verify-${TARGETED_RUN_ID}.json"

  if [ -f "$TARGETED_STATE_FILE" ]; then
    local prev_status
    prev_status=$(grep -o '"status":"[^"]*"' "$TARGETED_STATE_FILE" 2>/dev/null | cut -d'"' -f4 || true)
    if [ "$prev_status" = "failed" ] || [ "$prev_status" = "running" ]; then
      TARGETED_REUSE_REFUSED=1
      _fail "ERROR: Run ID ${TARGETED_RUN_ID} previously recorded as ${prev_status}. Reuse is refused."
    fi
  fi

  # Record initial running state atomically
  if ( set -o noclobber; cat <<EOF > "$TARGETED_STATE_FILE"
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"running","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
  ) 2>/dev/null; then
    chmod 600 "$TARGETED_STATE_FILE"
  else
    TARGETED_REUSE_REFUSED=1
    _fail "ERROR: Run ID ${TARGETED_RUN_ID} state file already exists. Concurrent or duplicate run refused."
  fi

  trap '_cleanup_targeted' EXIT
  trap '_record_targeted_failure 130; exit 130' INT
  trap '_record_targeted_failure 143; exit 143' TERM

  # Phase 2: Prerequisites & Ownership
  echo "--- Phase 2: Prerequisites and Ownership Validation ---"
  export PODMAN_COMPOSE_PROVIDER="${PODMAN_COMPOSE_PROVIDER:-podman-compose}"
  local provider="${PODMAN_COMPOSE_PROVIDER}"
  if ! command -v "$provider" >/dev/null 2>&1; then
    _record_targeted_failure 1
    _fail "ERROR: Compose provider '${provider}' is not available"
  fi
  if ! command -v podman >/dev/null 2>&1 || ! command -v podman-compose >/dev/null 2>&1; then
    _record_targeted_failure 1
    _fail "ERROR: podman or podman-compose not available"
  fi

  local clean_version
  clean_version=$(podman compose version 2>&1 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' || true)
  if ! echo "${clean_version}" | grep -Eq "^podman-compose version 1\.6\.0[[:space:]]*$"; then
    _record_targeted_failure 1
    _fail "ERROR: Requires podman-compose 1.6.0"
  fi

  # Verify no preexisting project resources exist before mutation
  local pre_c pre_v c_st=0 v_st=0
  pre_c=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}" --format '{{.Names}}' 2>&1) || c_st=$?
  if [ "$c_st" -ne 0 ]; then
    _record_targeted_failure 1
    _fail "ERROR: Container inventory inspection failed (exit code ${c_st}): ${pre_c}"
  fi
  if [ -n "$pre_c" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Preexisting containers detected for project ${COMPOSE_PROJECT_NAME}: ${pre_c}"
  fi
  pre_v=$(podman volume ls --filter "name=${COMPOSE_PROJECT_NAME}" --format '{{.Name}}' 2>&1) || v_st=$?
  if [ "$v_st" -ne 0 ]; then
    _record_targeted_failure 1
    _fail "ERROR: Volume inventory inspection failed (exit code ${v_st}): ${pre_v}"
  fi
  if [ -n "$pre_v" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Preexisting volumes detected for project ${COMPOSE_PROJECT_NAME}: ${pre_v}"
  fi

  # Injected prerequisite failure hook for testing
  if [ "${FOUNDATION_VERIFY_INJECT_FAIL:-}" = "prerequisite" ]; then
    echo "Simulating injected prerequisite failure (code 47)..." >&2
    _record_targeted_failure 47
    exit 47
  fi

  _validate_port_availability "$API_HOST_PORT" "API"
  _validate_port_availability "$WEB_HOST_PORT" "Web"

  # Phase 3: Affected Verification (Lifecycle & Signal Delivery)
  echo "--- Phase 3: Affected Verification (Startup, Signals & Readiness) ---"

  echo "Starting PostgreSQL container for ${COMPOSE_PROJECT_NAME}..."
  TARGETED_MUTATION_STARTED=1
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
    _record_targeted_failure 1
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
    _record_targeted_failure 1
    _fail "ERROR: Readiness probes timed out"
  fi

  echo "Testing graceful shutdown and signal delivery..."
  local stop_start stop_end stop_duration
  stop_start=$(date +%s)
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" stop api web
  stop_end=$(date +%s)
  stop_duration=$((stop_end - stop_start))
  echo "Stop completed in ${stop_duration}s."
  if [ "$stop_duration" -ge 10 ]; then
    _record_targeted_failure 1
    _fail "ERROR: Service stop duration (${stop_duration}s) exceeded 10-second grace period!"
  fi

  # Check logs for graceful shutdown
  local api_logs
  api_logs=$(podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" logs api 2>&1 || true)
  if ! echo "$api_logs" | grep -q "Received termination signal, starting graceful shutdown" || ! echo "$api_logs" | grep -q "Graceful shutdown completed"; then
    _record_targeted_failure 1
    _fail "ERROR: API logs did not capture required graceful shutdown completion messages!"
  fi
  echo "Verified: API received SIGTERM and executed graceful shutdown handlers."

  local api_exit web_exit
  api_exit=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*api" --format '{{.ExitCode}}' 2>/dev/null | tr -d '[:space:]' || true)
  web_exit=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*web" --format '{{.ExitCode}}' 2>/dev/null | tr -d '[:space:]' || true)
  echo "Container stop exit codes: api='${api_exit}', web='${web_exit}'"

  if [ -z "$api_exit" ] || [ -z "$web_exit" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Container exit codes could not be determined (blank inspection result)"
  fi
  if [ "$api_exit" = "unknown" ] || [ "$web_exit" = "unknown" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Container terminal state is unknown"
  fi
  if [ "$api_exit" = "137" ] || [ "$web_exit" = "137" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Container was terminated via forced SIGKILL (code 137)!"
  fi
  if [ "$api_exit" != "0" ]; then
    _record_targeted_failure 1
    _fail "ERROR: API container exited with unexpected non-zero code '${api_exit}' (expected 0)"
  fi
  if [ "$web_exit" != "0" ] && [ "$web_exit" != "143" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Web container exited with unexpected code '${web_exit}' (expected 0 or 143)"
  fi

  # Verify neither service was killed by OOM (fail-closed on inspection failure or non-false state)
  local api_oom web_oom api_oom_st=0 web_oom_st=0 api_cid web_cid
  api_cid=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*api" -q 2>/dev/null | head -n 1 || true)
  web_cid=$(podman ps -a --filter "name=${COMPOSE_PROJECT_NAME}.*web" -q 2>/dev/null | head -n 1 || true)
  if [ -z "$api_cid" ] || [ -z "$web_cid" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Could not resolve exact container ID for api or web"
  fi

  api_oom=$(podman inspect --format '{{.State.OOMKilled}}' "$api_cid" 2>&1) || api_oom_st=$?
  if [ "$api_oom_st" -ne 0 ]; then
    _record_targeted_failure 1
    _fail "ERROR: OOM inspection failed for API container $api_cid (exit code ${api_oom_st}): ${api_oom}"
  fi
  web_oom=$(podman inspect --format '{{.State.OOMKilled}}' "$web_cid" 2>&1) || web_oom_st=$?
  if [ "$web_oom_st" -ne 0 ]; then
    _record_targeted_failure 1
    _fail "ERROR: OOM inspection failed for Web container $web_cid (exit code ${web_oom_st}): ${web_oom}"
  fi

  if [ "$api_oom" != "false" ] || [ "$web_oom" != "false" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Service container was terminated by OOM killer or non-false OOM state (api_oom=${api_oom}, web_oom=${web_oom})"
  fi

  # Positive closure evidence: ports must not respond while stopped (any HTTP code indicates still open)
  local a_closed w_closed
  a_closed=$(curl -s --connect-timeout 1 --max-time 1 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_HOST_PORT}/health" 2>/dev/null || true)
  w_closed=$(curl -s --connect-timeout 1 --max-time 1 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/login" 2>/dev/null || true)
  if [ "$a_closed" != "000" ] && [ -n "$a_closed" ]; then
    _record_targeted_failure 1
    _fail "ERROR: API port still responding after stop command (HTTP code: ${a_closed})"
  fi
  if [ "$w_closed" != "000" ] && [ -n "$w_closed" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Web port still responding after stop command (HTTP code: ${w_closed})"
  fi

  echo "Testing restart reaching positive readiness..."
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" start api web

  local restart_ready=0
  for attempt in {1..30}; do
    local a_health a_ready w_login w_proxy
    a_health=$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_HOST_PORT}/health" || true)
    a_ready=$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_HOST_PORT}/ready" || true)
    w_login=$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/login" || true)
    w_proxy=$(curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_HOST_PORT}/auth/session-check" || true)
    if [ "$a_health" = "200" ] && [ "$a_ready" = "200" ] && [ "$w_login" = "200" ] && [ "$w_proxy" = "401" ]; then
      restart_ready=1
      echo "Restarted services verified ready (attempt ${attempt}): API health=200, ready=200; Web login=200, proxy=401."
      break
    fi
    sleep 1
  done
  if [ "$restart_ready" -ne 1 ]; then
    _record_targeted_failure 1
    _fail "ERROR: Services failed to become ready after restart"
  fi

  # Phase 4: Evidence Recording
  echo "--- Phase 4: Recording Evidence ---"
  TARGETED_PHASE4_PASSED=1
  TARGETED_API_EXIT="${api_exit}"
  TARGETED_WEB_EXIT="${web_exit}"
  echo "Targeted lifecycle and signal verification completed."
}

# --- Mode: integration-ci ---

_record_ci_failure() {
  local code="${1:-1}"
  if [ "${CI_REUSE_REFUSED:-0}" -eq 1 ]; then
    return
  fi
  if [ "$CI_FIRST_FAILURE" -eq 0 ]; then
    CI_FIRST_FAILURE="$code"
    if [ -n "${CI_STATE_FILE:-}" ]; then
      cat <<EOF > "$CI_STATE_FILE"
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","exit_code":${CI_FIRST_FAILURE},"cleanup_failure":${CI_CLEANUP_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$CI_STATE_FILE"
    fi
  fi
}

_cleanup_integration_ci() {
  local exit_code="$?"
  trap - EXIT INT TERM

  if [ "${CI_REUSE_REFUSED:-0}" -eq 1 ]; then
    exit "$exit_code"
  fi

  if [ "$exit_code" -ne 0 ] && [ "$CI_FIRST_FAILURE" -eq 0 ]; then
    _record_ci_failure "$exit_code"
  fi

  echo "--- Phase 5: Exact-Owned Cleanup (integration-ci) ---"

  # 1. Remove exact test runner container if started
  if [ -n "${CI_RUNNER_NAME:-}" ] && command -v podman >/dev/null 2>&1; then
    if podman container exists "$CI_RUNNER_NAME" 2>/dev/null; then
      echo "Removing test runner container ${CI_RUNNER_NAME}..."
      if ! podman rm -f "$CI_RUNNER_NAME" >/dev/null 2>&1; then
        echo "ERROR: Failed to remove test runner container ${CI_RUNNER_NAME}" >&2
        CI_CLEANUP_FAILURE=1
      fi
    fi
  fi

  # 2. Check for leftover testcontainers created during the run
  # Only remove containers with verified run label matching this run ID or runner name
  if [ -n "${CI_BASELINE_FILE:-}" ] && [ -f "$CI_BASELINE_FILE" ] && command -v podman >/dev/null 2>&1; then
    if ! podman ps -aq --no-trunc > "${CI_CURRENT_FILE:-/tmp/cur_c.txt}"; then
      echo "ERROR: Failed to inspect current container inventory" >&2
      CI_CLEANUP_FAILURE=1
    else
      local candidate_cids
      candidate_cids=$(grep -v -F -f "$CI_BASELINE_FILE" "${CI_CURRENT_FILE:-/tmp/cur_c.txt}" 2>/dev/null || true)
      for cid in $candidate_cids; do
        if [ -z "$cid" ]; then continue; fi
        local is_runner insp_st=0
        is_runner=$(podman inspect "$cid" --format '{{index .Config.Labels "io.9gotstory.s2-assets.integ-run"}}' 2>&1) || insp_st=$?
        if [ "$insp_st" -ne 0 ]; then
          echo "ERROR: Failed to inspect container $cid (exit $insp_st): $is_runner" >&2
          CI_CLEANUP_FAILURE=1
          continue
        fi
        if [ "$is_runner" = "$CI_RUN_ID" ] || [ "$cid" = "${CI_RUNNER_NAME:-}" ]; then
          echo "Removing verified test-owned container: $cid"
          if ! podman rm -f "$cid" >/dev/null 2>&1; then
            echo "ERROR: Failed to remove test container $cid" >&2
            CI_CLEANUP_FAILURE=1
          fi
        else
          echo "Preserving non-test / concurrent container: $cid"
        fi
      done
    fi
  fi

  # 3. Cleanly stop private rootless endpoint PID
  if [ -n "${CI_ENDPOINT_PID:-}" ]; then
    if kill -0 "$CI_ENDPOINT_PID" 2>/dev/null; then
      echo "Stopping private rootless endpoint PID $CI_ENDPOINT_PID..."
      kill "$CI_ENDPOINT_PID" 2>/dev/null || true
      local pid_stopped=0
      for _ in {1..20}; do
        if ! kill -0 "$CI_ENDPOINT_PID" 2>/dev/null; then
          pid_stopped=1
          break
        fi
        sleep 0.2
      done
      if [ "$pid_stopped" -ne 1 ]; then
        echo "ERROR: Endpoint PID did not stop within timeout; terminating" >&2
        CI_CLEANUP_FAILURE=1
        kill -9 "$CI_ENDPOINT_PID" 2>/dev/null || true
      fi
    fi
  fi

  # 4. Remove temporary endpoint directory ONLY if created by this run
  if [ "${CI_RUN_DIR_CREATED:-0}" -eq 1 ] && [ -n "${CI_RUN_DIR:-}" ]; then
    if [ -d "$CI_RUN_DIR" ]; then
      local cur_inode cur_uid st=0
      cur_inode=$(stat -c "%i" "$CI_RUN_DIR" 2>/dev/null || stat -f "%i" "$CI_RUN_DIR" 2>/dev/null) || st=$?
      cur_uid=$(stat -c "%u" "$CI_RUN_DIR" 2>/dev/null || stat -f "%u" "$CI_RUN_DIR" 2>/dev/null || true)
      if [ "$st" -ne 0 ] || [ -z "$cur_inode" ] || [ "$cur_inode" != "$CI_RUN_DIR_INODE" ] || [ "$cur_uid" != "$(id -u)" ]; then
        echo "ERROR: Cleanup identity mismatch for endpoint directory $CI_RUN_DIR (recorded inode: $CI_RUN_DIR_INODE, current: $cur_inode, current uid: $cur_uid). Retaining directory." >&2
        CI_CLEANUP_FAILURE=1
      else
        rm -rf "$CI_RUN_DIR"
      fi
    else
      echo "ERROR: Expected endpoint directory $CI_RUN_DIR missing before cleanup removal" >&2
      CI_CLEANUP_FAILURE=1
    fi
  fi

  # 5. Record final durable state
  if [ "${CI_REUSE_REFUSED:-0}" -eq 0 ] && [ -n "${CI_STATE_FILE:-}" ]; then
    if [ "$CI_FIRST_FAILURE" -eq 0 ] && [ "$CI_CLEANUP_FAILURE" -eq 0 ] && [ "$CI_VERIFIED" -eq 1 ]; then
      cat <<EOF > "$CI_STATE_FILE"
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"passed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$CI_STATE_FILE"
    else
      local eff_code="$CI_FIRST_FAILURE"
      if [ "$eff_code" -eq 0 ]; then eff_code=1; fi
      cat <<EOF > "$CI_STATE_FILE"
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","exit_code":${eff_code},"cleanup_failure":${CI_CLEANUP_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$CI_STATE_FILE"
    fi
  fi

  if [ "$CI_FIRST_FAILURE" -ne 0 ]; then
    echo "Integration-CI exiting with preserved first failure code: ${CI_FIRST_FAILURE}" >&2
    exit "$CI_FIRST_FAILURE"
  fi

  if [ "$CI_CLEANUP_FAILURE" -ne 0 ]; then
    echo "ERROR: Cleanup failed or uncertain; exiting with 1" >&2
    exit 1
  fi

  exit 0
}

_run_integration_ci() {
  echo "=== Running Fixed-Purpose Verification: Mode 'integration-ci' ==="

  CI_RUN_ID="ci_integ_${GITHUB_RUN_ID:-$$}"
  CI_STATE_FILE="${TMPDIR:-/tmp}/.verify_integ_${CI_RUN_ID}.json"

  if [ -f "$CI_STATE_FILE" ]; then
    local prev_ci_status
    prev_ci_status=$(grep -o '"status":"[^"]*"' "$CI_STATE_FILE" 2>/dev/null | cut -d'"' -f4 || true)
    if [ "$prev_ci_status" = "failed" ] || [ "$prev_ci_status" = "running" ]; then
      CI_REUSE_REFUSED=1
      _fail "ERROR: Integration run ID ${CI_RUN_ID} previously recorded as ${prev_ci_status}. Reuse is refused."
    fi
  fi

  # Record initial running state atomically
  if ( set -o noclobber; cat <<EOF > "$CI_STATE_FILE"
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"running","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
  ) 2>/dev/null; then
    chmod 600 "$CI_STATE_FILE"
  else
    CI_REUSE_REFUSED=1
    _fail "ERROR: Integration run ID ${CI_RUN_ID} state file already exists. Concurrent or duplicate run refused."
  fi

  trap '_cleanup_integration_ci' EXIT
  trap '_record_ci_failure 130; exit 130' INT
  trap '_record_ci_failure 143; exit 143' TERM

  CI_RUN_DIR="/tmp/s2_integ_sock_${CI_RUN_ID}"
  if [ -e "$CI_RUN_DIR" ]; then
    _record_ci_failure 1
    _fail "ERROR: Private endpoint directory already exists: ${CI_RUN_DIR}"
  fi
  mkdir -m 700 "$CI_RUN_DIR"
  CI_RUN_DIR_CREATED=1
  CI_RUN_DIR_INODE=$(stat -c "%i" "$CI_RUN_DIR" 2>/dev/null || stat -f "%i" "$CI_RUN_DIR" 2>/dev/null || true)

  CI_ENDPOINT_SOCK="${CI_RUN_DIR}/podman.sock"
  CI_BASELINE_FILE="${CI_RUN_DIR}/baseline_containers.txt"
  CI_CURRENT_FILE="${CI_RUN_DIR}/current_containers.txt"
  CI_RUNNER_NAME="s2_integ_runner_${CI_RUN_ID}"

  # Phase 1 & 2: Setup Private Owned Endpoint & Mount Guards
  echo "--- Phase 1 & 2: Private Endpoint Setup & Fail-Closed Mount Guards ---"
  podman system service --time=0 "unix://${CI_ENDPOINT_SOCK}" &
  CI_ENDPOINT_PID=$!

  local sock_ready=0
  for _ in {1..30}; do
    if [ -S "$CI_ENDPOINT_SOCK" ]; then
      sock_ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$sock_ready" -ne 1 ]; then
    _record_ci_failure 1
    _fail "ERROR: Private endpoint socket failed to initialize: ${CI_ENDPOINT_SOCK}"
  fi
  chmod 600 "$CI_ENDPOINT_SOCK"

  # Enforce fail-closed socket and directory guards
  _validate_endpoint_socket_guards "$CI_ENDPOINT_SOCK" "$CI_RUN_DIR"

  # Bounded ping/info verification with fail-closed HTTP status check
  if ! curl --fail -s --connect-timeout 2 --max-time 3 --unix-socket "$CI_ENDPOINT_SOCK" http://d/v5.0.0/libpod/info >/dev/null 2>&1; then
    _record_ci_failure 1
    _fail "ERROR: Private endpoint socket connection verification failed"
  fi
  echo "Private owned endpoint verified: ${CI_ENDPOINT_SOCK} (PID ${CI_ENDPOINT_PID})"

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
  podman ps -aq --no-trunc > "$CI_BASELINE_FILE"

  # Phase 3: Run integration tests with safe mount contract (NO :z or :Z on socket)
  echo "--- Phase 3: Running Integration Tests via Safe Private Endpoint ---"
  CI_MUTATION_STARTED=1
  podman run --name "$CI_RUNNER_NAME" --rm \
    --network=host \
    --userns=keep-id \
    -u 1001:1001 \
    --security-opt label=disable \
    --label "io.9gotstory.s2-assets.integ-run=${CI_RUN_ID}" \
    -v "${REPO_ROOT}:/work:z" \
    -v "${CI_ENDPOINT_SOCK}:${CI_ENDPOINT_SOCK}" \
    -w /work \
    -e DOCKER_HOST="unix://${CI_ENDPOINT_SOCK}" \
    -e CONTAINER_HOST="unix://${CI_ENDPOINT_SOCK}" \
    -e TESTCONTAINERS_RYUK_DISABLED="true" \
    -e TESTCONTAINERS_HOST_OVERRIDE="127.0.0.1" \
    -e CI="true" \
    s2-assets-integration:ci \
    sh -c 'podman --remote --url "$CONTAINER_HOST" info >/dev/null && pnpm --filter api exec vitest run tests/integration'

  CI_VERIFIED=1
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
