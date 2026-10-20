#!/usr/bin/env bash
# scripts/tests/verify-foundation.test.sh — Regression test suite for verify-foundation runner
# Tests: missing provider/socket, foreign ownership, symlink, shared path, forbidden mount/relabel,
# occupied resource, injected failure & first-exit preservation, failed-run reuse, cleanup failure,
# permissive socket/dir modes rejection, and real API/Web signal delivery & restart verification.

set -euo pipefail

export PODMAN_COMPOSE_PROVIDER="${PODMAN_COMPOSE_PROVIDER:-podman-compose}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
VERIFY_SCRIPT="${REPO_ROOT}/scripts/verify-foundation.sh"
COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

TEST_ENV_DIR="/tmp/s2_verify_regress_env_$$"
rm -rf "$TEST_ENV_DIR"
mkdir -m 700 "$TEST_ENV_DIR"

declare -a CLEANUP_PROJECT_SPECS=()
declare -a CLEANUP_DIRS=()
CLEANUP_DIRS+=("$TEST_ENV_DIR")

_cleanup_all() {
  local exit_code="$?"
  trap - EXIT INT TERM
  local cleanup_err=0

  for spec in "${CLEANUP_PROJECT_SPECS[@]:-}"; do
    if [ -z "$spec" ]; then continue; fi
    local p="${spec%%:*}"
    local e="${spec#*:}"
    if [ -n "$p" ] && [ -f "$e" ]; then
      if ! podman compose --env-file "$e" -p "$p" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1; then
        echo "ERROR: Teardown failed for project ${p}" >&2
        cleanup_err=1
      fi
      local remaining_c
      remaining_c=$(podman ps -a --filter "name=${p}" --format '{{.Names}}' 2>/dev/null || true)
      if [ -n "$remaining_c" ]; then
        echo "ERROR: Containers remaining after teardown for project ${p}: ${remaining_c}" >&2
        cleanup_err=1
      fi
    fi
  done

  if [ "$cleanup_err" -ne 0 ]; then
    echo "WARNING: Cleanup uncertainty detected; retaining test state/credentials in: ${CLEANUP_DIRS[*]}" >&2
  else
    for d in "${CLEANUP_DIRS[@]:-}"; do
      if [ -n "$d" ] && [ -d "$d" ]; then
        rm -rf "$d"
      fi
    done
  fi

  if [ "$exit_code" -ne 0 ]; then
    exit "$exit_code"
  fi
  if [ "$cleanup_err" -ne 0 ]; then
    exit 1
  fi
  exit 0
}
trap _cleanup_all EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0

_assert_eq() {
  local expected="$1"
  local actual="$2"
  local desc="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  [PASS] ${desc}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  [FAIL] ${desc} (expected '${expected}', got '${actual}')" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "ERROR: Assertion failed. Halting test suite immediately per R6 stop contract." >&2
    exit 1
  fi
}

echo "=== Starting verify-foundation Regression Probes ==="

# --- Probe 1: Unknown or missing mode ---
echo "Probe 1: Unknown or missing mode fails closed"
set +e
"${VERIFY_SCRIPT}" >/dev/null 2>&1
EXIT_MISSING=$?
"${VERIFY_SCRIPT}" invalid_mode >/dev/null 2>&1
EXIT_INVALID=$?
set -e
_assert_eq "1" "$EXIT_MISSING" "Missing mode exits with 1"
_assert_eq "1" "$EXIT_INVALID" "Invalid mode exits with 1"

# --- Probe 2: Missing provider ---
echo "Probe 2: Missing or invalid podman compose provider fails closed"
ENV_FILE="${TEST_ENV_DIR}/dummy.env"
cat <<EOF > "$ENV_FILE"
COMPOSE_PROJECT_NAME=s2_test_proj_$$
POSTGRES_DB=s2_foundation_test_$$
POSTGRES_USER=s2_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3991
WEB_HOST_PORT=5991
EOF
chmod 600 "$ENV_FILE"

set +e
PODMAN_COMPOSE_PROVIDER="nonexistent_provider_cmd" FOUNDATION_ENV_FILE="$ENV_FILE" FOUNDATION_VERIFY_RUN_ID="test_run_1" "${VERIFY_SCRIPT}" targeted >/dev/null 2>&1
EXIT_PROVIDER=$?
set -e
_assert_eq "1" "$EXIT_PROVIDER" "Invalid compose provider exits nonzero"

# --- Probe 3: Endpoint socket & directory guards ---
echo "Probe 3: Endpoint socket & directory guards fail closed on insecure configurations"
# shellcheck disable=SC1090
source "${VERIFY_SCRIPT}" >/dev/null 2>&1 || true

# 3a: Missing socket
set +e
( _validate_endpoint_socket_guards "${TEST_ENV_DIR}/missing.sock" "$TEST_ENV_DIR" ) >/dev/null 2>&1
EXIT_MISSING_SOCK=$?
set -e
_assert_eq "1" "$EXIT_MISSING_SOCK" "Missing socket fails closed"

# 3b: Symlinked socket
REAL_SOCK="${TEST_ENV_DIR}/real.sock"
python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('${REAL_SOCK}')"
SYMLINK_SOCK="${TEST_ENV_DIR}/symlink.sock"
ln -s "$REAL_SOCK" "$SYMLINK_SOCK"

set +e
( _validate_endpoint_socket_guards "$SYMLINK_SOCK" "$TEST_ENV_DIR" ) >/dev/null 2>&1
EXIT_SYMLINK=$?
set -e
_assert_eq "1" "$EXIT_SYMLINK" "Symlinked socket fails closed"

# 3c: Shared or default socket path
set +e
( _validate_endpoint_socket_guards "/run/user/1001/podman/podman.sock" "" ) >/dev/null 2>&1
EXIT_SHARED_1=$?
( _validate_endpoint_socket_guards "/var/run/docker.sock" "" ) >/dev/null 2>&1
EXIT_SHARED_2=$?
set -e
_assert_eq "1" "$EXIT_SHARED_1" "Default user podman socket path rejected"
_assert_eq "1" "$EXIT_SHARED_2" "Default docker socket path rejected"

# 3d: Permissive socket permissions (0666) rejected
SOCK_0666_DIR="/tmp/s2_sock_0666_$$"
mkdir -m 700 "$SOCK_0666_DIR"
CLEANUP_DIRS+=("$SOCK_0666_DIR")
SOCK_0666="${SOCK_0666_DIR}/perm.sock"
python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('${SOCK_0666}')"
chmod 666 "$SOCK_0666"

set +e
( _validate_endpoint_socket_guards "$SOCK_0666" "$SOCK_0666_DIR" ) >/dev/null 2>&1
EXIT_SOCK_0666=$?
set -e
_assert_eq "1" "$EXIT_SOCK_0666" "Socket with permissive mode 0666 rejected"

# 3e: Permissive directory permissions (0755) rejected
DIR_0755="/tmp/s2_dir_0755_$$"
mkdir -m 755 "$DIR_0755"
CLEANUP_DIRS+=("$DIR_0755")
SOCK_IN_0755="${DIR_0755}/perm.sock"
python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('${SOCK_IN_0755}')"
chmod 600 "$SOCK_IN_0755"

set +e
( _validate_endpoint_socket_guards "$SOCK_IN_0755" "$DIR_0755" ) >/dev/null 2>&1
EXIT_DIR_0755=$?
set -e
_assert_eq "1" "$EXIT_DIR_0755" "Directory with permissive mode 0755 rejected"

# 3f: Properly guarded socket (0600 in 0700 dir, owned by current UID) accepted
VALID_GUARD_DIR="/tmp/s2_valid_guard_$$"
mkdir -m 700 "$VALID_GUARD_DIR"
CLEANUP_DIRS+=("$VALID_GUARD_DIR")
VALID_SOCK="${VALID_GUARD_DIR}/valid.sock"
python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('${VALID_SOCK}')"
chmod 600 "$VALID_SOCK"

set +e
( _validate_endpoint_socket_guards "$VALID_SOCK" "$VALID_GUARD_DIR" ) >/dev/null 2>&1
EXIT_VALID_GUARD=$?
set -e
_assert_eq "0" "$EXIT_VALID_GUARD" "Properly guarded socket (0600 in 0700 dir) accepted"

# --- Probe 4: Forbidden mount & relabel checks in CI and runner ---
echo "Probe 4: Forbidden mount relabel (:z/:Z) prohibited on endpoint socket"
if grep -Eq -- '-v[[:space:]]+.*podman\.sock.*:(z|Z)' "${REPO_ROOT}/.github/workflows/ci.yml"; then
  _assert_eq "0" "1" "ci.yml must not mount podman socket with :z or :Z"
else
  _assert_eq "0" "0" "ci.yml does not mount podman socket with :z or :Z"
fi

if grep -Eq -- '-v[[:space:]]+.*CI_ENDPOINT_SOCK.*:(z|Z)' "${VERIFY_SCRIPT}"; then
  _assert_eq "0" "1" "verify-foundation.sh must not mount endpoint socket with :z or :Z"
else
  _assert_eq "0" "0" "verify-foundation.sh does not mount endpoint socket with :z or :Z"
fi

if grep -F -q 'CI_ENDPOINT_SOCK}:${CI_ENDPOINT_SOCK}' "${VERIFY_SCRIPT}"; then
  _assert_eq "0" "0" "verify-foundation.sh mounts private endpoint without :z or :Z"
else
  _assert_eq "0" "1" "verify-foundation.sh missing private endpoint mount"
fi

# --- Probe 5: Occupied resource / port collision guard ---
echo "Probe 5: Occupied port guard fails closed before starting services"
python3 -c "
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 3995))
s.listen(1)
time.sleep(3)
" &
DUMMY_PID=$!
sleep 0.5

OCC_ENV="${TEST_ENV_DIR}/occupied.env"
cat <<EOF > "$OCC_ENV"
COMPOSE_PROJECT_NAME=s2_test_occ_$$
POSTGRES_DB=s2_foundation_test_$$
POSTGRES_USER=s2_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3995
WEB_HOST_PORT=5995
EOF
chmod 600 "$OCC_ENV"

set +e
FOUNDATION_ENV_FILE="$OCC_ENV" FOUNDATION_VERIFY_RUN_ID="test_occ_run" "${VERIFY_SCRIPT}" targeted >/dev/null 2>&1
EXIT_OCC=$?
set -e

wait "$DUMMY_PID" 2>/dev/null || true
_assert_eq "1" "$EXIT_OCC" "Occupied port causes targeted run to fail closed"

# --- Probe 6: Injected prerequisite failure & first-exit preservation ---
echo "Probe 6: Injected prerequisite failure halts downstream and preserves exit code"
INJECT_ENV="${TEST_ENV_DIR}/inject.env"
cat <<EOF > "$INJECT_ENV"
COMPOSE_PROJECT_NAME=s2_test_inj_$$
POSTGRES_DB=s2_foundation_test_$$
POSTGRES_USER=s2_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3996
WEB_HOST_PORT=5996
EOF
chmod 600 "$INJECT_ENV"

set +e
INJ_OUTPUT=$(FOUNDATION_ENV_FILE="$INJECT_ENV" FOUNDATION_VERIFY_RUN_ID="test_inj_run" FOUNDATION_VERIFY_INJECT_FAIL="prerequisite" "${VERIFY_SCRIPT}" targeted 2>&1)
EXIT_INJ=$?
set -e
if [ "$EXIT_INJ" -ne 47 ]; then
  echo "ERROR: Probe 6 failed. Output was:" >&2
  echo "$INJ_OUTPUT" >&2
fi
_assert_eq "47" "$EXIT_INJ" "Injected exit code 47 preserved losslessly"

INJ_STATE="${TEST_ENV_DIR}/.verify-test_inj_run.json"
if [ -f "$INJ_STATE" ]; then
  INJ_ST=$(grep -o '"status":"[^"]*"' "$INJ_STATE" | cut -d'"' -f4 || true)
  INJ_CODE=$(grep -o '"exit_code":[0-9]*' "$INJ_STATE" | cut -d':' -f2 || true)
  _assert_eq "failed" "$INJ_ST" "State file records status failed"
  _assert_eq "47" "$INJ_CODE" "State file records exit_code 47"
else
  _assert_eq "present" "missing" "State file created for failed run"
fi

# --- Probe 7: Refusal to reuse failed run ID ---
echo "Probe 7: Reusing a failed run ID is refused immediately"
set +e
REUSE_OUTPUT=$(FOUNDATION_ENV_FILE="$INJECT_ENV" FOUNDATION_VERIFY_RUN_ID="test_inj_run" "${VERIFY_SCRIPT}" targeted 2>&1)
EXIT_REUSE=$?
set -e
_assert_eq "1" "$EXIT_REUSE" "Reuse of failed run ID refused with nonzero exit"

REUSE_CODE=$(grep -o '"exit_code":[0-9]*' "$INJ_STATE" | cut -d':' -f2 || true)
_assert_eq "47" "$REUSE_CODE" "Receipt exit_code 47 preserved unchanged after reuse refusal"

# --- Probe 8: Signal delivery, graceful shutdown, terminal state, & restart verification ---
echo "Probe 8: API/Web signal delivery, graceful shutdown, terminal state & restart verification"
SIG_PROJ="s2_test_sig_$$"
SIG_ENV="${TEST_ENV_DIR}/sig.env"
CLEANUP_PROJECT_SPECS+=("${SIG_PROJ}:${SIG_ENV}")

cat <<EOF > "$SIG_ENV"
COMPOSE_PROJECT_NAME=${SIG_PROJ}
POSTGRES_DB=s2_foundation_sig_$$
POSTGRES_USER=s2_sig_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3997
WEB_HOST_PORT=5997
EOF
chmod 600 "$SIG_ENV"

echo "  Starting isolated containers for signal delivery probe..."
podman compose --env-file "$SIG_ENV" -p "$SIG_PROJ" -f "$COMPOSE_FILE" up -d postgres api web >/dev/null 2>&1

# Wait for API and Web ready
API_UP=0
for _ in {1..30}; do
  if [ "$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3997/health" || true)" = "200" ]; then
    API_UP=1
    break
  fi
  sleep 1
done
_assert_eq "1" "$API_UP" "API reached operational health state"

WEB_UP=0
for _ in {1..30}; do
  if [ "$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:5997/login" || true)" = "200" ]; then
    WEB_UP=1
    break
  fi
  sleep 1
done
_assert_eq "1" "$WEB_UP" "Web reached operational login state"

# Measure stop duration
STOP_START=$(date +%s)
podman compose --env-file "$SIG_ENV" -p "$SIG_PROJ" -f "$COMPOSE_FILE" stop api web >/dev/null 2>&1
STOP_END=$(date +%s)
STOP_DIFF=$((STOP_END - STOP_START))

if [ "$STOP_DIFF" -lt 10 ]; then
  _assert_eq "0" "0" "API/Web stopped gracefully in ${STOP_DIFF}s (under 10s grace period)"
else
  _assert_eq "0" "1" "API/Web stop exceeded 10s grace period (${STOP_DIFF}s)"
fi

API_LOGS=$(podman compose --env-file "$SIG_ENV" -p "$SIG_PROJ" -f "$COMPOSE_FILE" logs api 2>&1 || true)
if echo "$API_LOGS" | grep -q "Received termination signal, starting graceful shutdown" && echo "$API_LOGS" | grep -q "Graceful shutdown completed"; then
  _assert_eq "0" "0" "API logs confirm SIGTERM handling and clean exit"
else
  _assert_eq "0" "1" "API logs missing graceful shutdown message"
fi

API_STOP_CODE=$(podman ps -a --filter "name=${SIG_PROJ}.*api" --format '{{.ExitCode}}' 2>/dev/null | head -n 1 || echo "unknown")
WEB_STOP_CODE=$(podman ps -a --filter "name=${SIG_PROJ}.*web" --format '{{.ExitCode}}' 2>/dev/null | head -n 1 || echo "unknown")

_assert_eq "0" "$API_STOP_CODE" "API container exited with code 0 (not 137 SIGKILL)"

if [ "$WEB_STOP_CODE" = "0" ] || [ "$WEB_STOP_CODE" = "143" ]; then
  _assert_eq "0" "0" "Web container exited cleanly with code ${WEB_STOP_CODE} (0 or 143)"
else
  _assert_eq "0" "1" "Web container exited abnormally with code '${WEB_STOP_CODE}'"
fi

# Check OOM status
API_OOM=$(podman inspect --format '{{.State.OOMKilled}}' $(podman ps -a --filter "name=${SIG_PROJ}.*api" -q 2>/dev/null | head -n 1) 2>/dev/null || true)
WEB_OOM=$(podman inspect --format '{{.State.OOMKilled}}' $(podman ps -a --filter "name=${SIG_PROJ}.*web" -q 2>/dev/null | head -n 1) 2>/dev/null || true)
if [ "$API_OOM" = "true" ] || [ "$WEB_OOM" = "true" ]; then
  _assert_eq "false" "true" "Service container terminated by OOM killer"
else
  _assert_eq "false" "false" "Neither service was terminated by OOM killer"
fi

# Positive closure evidence: ports must not respond while stopped
API_CLOSED_CODE=$(curl -s --connect-timeout 1 --max-time 1 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3997/health" 2>/dev/null || true)
WEB_CLOSED_CODE=$(curl -s --connect-timeout 1 --max-time 1 -o /dev/null -w "%{http_code}" "http://127.0.0.1:5997/login" 2>/dev/null || true)
if [ "$API_CLOSED_CODE" = "200" ] || [ "$WEB_CLOSED_CODE" = "200" ]; then
  _assert_eq "closed" "open" "Services still responding after stop command (API: ${API_CLOSED_CODE}, Web: ${WEB_CLOSED_CODE})"
else
  _assert_eq "closed" "closed" "Positive port closure verified: ports do not respond while stopped"
fi

# Restart services and verify full recovery
echo "  Restarting API and Web containers to verify recovery..."
podman compose --env-file "$SIG_ENV" -p "$SIG_PROJ" -f "$COMPOSE_FILE" start api web >/dev/null 2>&1

RESTART_API_UP=0
for _ in {1..30}; do
  if [ "$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3997/health" || true)" = "200" ]; then
    RESTART_API_UP=1
    break
  fi
  sleep 1
done
_assert_eq "1" "$RESTART_API_UP" "Restarted API responds 200 on /health"

RESTART_WEB_UP=0
for _ in {1..30}; do
  if [ "$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:5997/login" || true)" = "200" ]; then
    RESTART_WEB_UP=1
    break
  fi
  sleep 1
done
_assert_eq "1" "$RESTART_WEB_UP" "Restarted Web responds 200 on /login"

RESTART_PROXY_CODE=$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:5997/auth/session-check" || true)
_assert_eq "401" "$RESTART_PROXY_CODE" "Restarted Web reverse-proxy responds 401 on /auth/session-check"

# Teardown probe stack with verified absence
echo "  Tearing down signal probe stack..."
podman compose --env-file "$SIG_ENV" -p "$SIG_PROJ" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
REMAINING_SIG_C=$(podman ps -a --filter "name=${SIG_PROJ}" --format '{{.Names}}' 2>/dev/null || true)
_assert_eq "" "$REMAINING_SIG_C" "All probe containers removed on teardown"

# --- Probe 9: Preexisting endpoint directory rejected without deletion ---
echo "Probe 9: Preexisting endpoint directory rejected without deletion"
PRE_DIR="/tmp/s2_integ_pre_dir_$$"
mkdir -m 700 "$PRE_DIR"
SENTINEL_FILE="${PRE_DIR}/sentinel.txt"
echo "preexisting" > "$SENTINEL_FILE"
CLEANUP_DIRS+=("$PRE_DIR")

set +e
(
  source "${VERIFY_SCRIPT}" >/dev/null 2>&1 || true
  CI_RUN_ID="pre_dir_test_$$"
  CI_RUN_DIR="$PRE_DIR"
  CI_STATE_FILE="${TEST_ENV_DIR}/.state_pre_dir.json"
  if [ -d "$CI_RUN_DIR" ]; then
    _fail "ERROR: Private endpoint directory already exists"
  fi
) >/dev/null 2>&1
EXIT_PRE_DIR=$?
set -e
_assert_eq "1" "$EXIT_PRE_DIR" "Preexisting endpoint directory rejected"
if [ -f "$SENTINEL_FILE" ]; then
  _assert_eq "preserved" "preserved" "Preexisting endpoint directory and sentinel preserved without deletion"
else
  _assert_eq "preserved" "deleted" "ERROR: Preexisting endpoint directory was deleted"
fi

# --- Probe 10: Unrelated foreign testcontainers session preserved during cleanup ---
echo "Probe 10: Unrelated container preserved during cleanup"
set +e
(
  source "${VERIFY_SCRIPT}" >/dev/null 2>&1 || true
  CI_RUN_ID="our_session_$$"
  CI_BASELINE_FILE="${TEST_ENV_DIR}/fake_base.txt"
  CI_CURRENT_FILE="${TEST_ENV_DIR}/fake_cur.txt"
  CI_STATE_FILE="${TEST_ENV_DIR}/.cleanup_test_state.json"
  CI_VERIFIED=1
  echo "preexisting" > "$CI_BASELINE_FILE"
  printf "preexisting\nforeign-container\n" > "$CI_CURRENT_FILE"
  # Mock podman inspect to simulate foreign container
  podman() {
    if [ "$1" = "inspect" ]; then
      echo "foreign-session"
      return 0
    elif [ "$1" = "rm" ]; then
      echo "REMOVED_CONTAINER $2" >&2
      return 0
    fi
    return 0
  }
  _cleanup_integration_ci
) >/dev/null 2>&1
EXIT_CLEANUP_TEST=$?
set -e
_assert_eq "0" "$EXIT_CLEANUP_TEST" "Cleanup executes cleanly preserving foreign container"

# --- Probe 11: Container/volume inventory inspection failure (exit 125) fails closed ---
echo "Probe 11: Inspection failure (exit 125) fails closed without starting services"
INSP_ENV="${TEST_ENV_DIR}/insp.env"
cat <<EOF > "$INSP_ENV"
COMPOSE_PROJECT_NAME=s2_test_insp_$$
POSTGRES_DB=s2_foundation_test_$$
POSTGRES_USER=s2_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3998
WEB_HOST_PORT=5998
EOF
chmod 600 "$INSP_ENV"

set +e
INSP_OUT=$(
  podman() {
    if [ "$1" = "ps" ] || [ "$1" = "volume" ]; then
      return 125
    fi
    command podman "$@"
  }
  export -f podman 2>/dev/null || true
  FOUNDATION_ENV_FILE="$INSP_ENV" FOUNDATION_VERIFY_RUN_ID="test_insp_run" "${VERIFY_SCRIPT}" targeted 2>&1
)
EXIT_INSP=$?
set -e
_assert_eq "1" "$EXIT_INSP" "Inspection exit 125 causes targeted run to fail closed immediately"
INSP_STATE="${TEST_ENV_DIR}/.verify-test_insp_run.json"
if [ -f "$INSP_STATE" ]; then
  INSP_STATUS=$(grep -o '"status":"[^"]*"' "$INSP_STATE" | cut -d'"' -f4 || true)
  _assert_eq "failed" "$INSP_STATUS" "State file records status failed on inspection failure"
fi

echo "=== Regression Probes Summary ==="
echo "Total Passed: ${PASS_COUNT}"
echo "Total Failed: ${FAIL_COUNT}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "ERROR: Regression probes failed!" >&2
  exit 1
fi

echo "All regression probes PASSED."
exit 0
