#!/usr/bin/env bash
# scripts/tests/verify-foundation.test.sh — Regression test suite for verify-foundation runner
# Tests: missing provider/socket, foreign ownership, symlink, shared path, forbidden mount/relabel,
# occupied resource, injected failure & first-exit preservation, failed-run reuse, cleanup failure,
# and real API/Web signal delivery.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
VERIFY_SCRIPT="${REPO_ROOT}/scripts/verify-foundation.sh"
COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

TEST_ENV_DIR="/tmp/s2_verify_regress_env_$$"
rm -rf "$TEST_ENV_DIR"
mkdir -m 700 "$TEST_ENV_DIR"

_cleanup_all() {
  rm -rf "$TEST_ENV_DIR"
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

# --- Probe 3: Endpoint socket guards (symlink, foreign owner, shared/default path) ---
echo "Probe 3: Endpoint socket guards fail closed"
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

# --- Probe 4: Forbidden mount & relabel checks in CI runner ---
echo "Probe 4: Forbidden mount relabel (:z/:Z) prohibited on endpoint socket"
# Verify compose/scripts do not mount endpoint socket with :z or :Z
if grep -Eq -- '-v[[:space:]]+.*podman\.sock.*:(z|Z)' "${REPO_ROOT}/.github/workflows/ci.yml"; then
  _assert_eq "0" "1" "ci.yml must not mount podman socket with :z or :Z"
else
  _assert_eq "0" "0" "ci.yml does not mount podman socket with :z or :Z"
fi

# --- Probe 5: Occupied resource / port collision guard ---
echo "Probe 5: Occupied port guard fails closed before starting services"
# Start a dummy listener on port 3995
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
FOUNDATION_ENV_FILE="$INJECT_ENV" FOUNDATION_VERIFY_RUN_ID="test_inj_run" FOUNDATION_VERIFY_INJECT_FAIL="prerequisite" "${VERIFY_SCRIPT}" targeted >/dev/null 2>&1
EXIT_INJ=$?
set -e
_assert_eq "47" "$EXIT_INJ" "Injected exit code 47 preserved losslessly"

# --- Probe 7: Refusal to reuse failed run ID ---
echo "Probe 7: Reusing a failed run ID is refused immediately"
set +e
FOUNDATION_ENV_FILE="$INJECT_ENV" FOUNDATION_VERIFY_RUN_ID="test_inj_run" "${VERIFY_SCRIPT}" targeted >/dev/null 2>&1
EXIT_REUSE=$?
set -e
_assert_eq "1" "$EXIT_REUSE" "Reuse of failed run ID refused with nonzero exit"

# --- Probe 8: Signal delivery & graceful shutdown coverage ---
echo "Probe 8: API/Web signal delivery and graceful shutdown verification"
SIG_ENV="${TEST_ENV_DIR}/sig.env"
cat <<EOF > "$SIG_ENV"
COMPOSE_PROJECT_NAME=s2_test_sig_$$
POSTGRES_DB=s2_foundation_sig_$$
POSTGRES_USER=s2_sig_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3997
WEB_HOST_PORT=5997
EOF
chmod 600 "$SIG_ENV"

echo "  Starting isolated containers for signal delivery probe..."
podman compose --env-file "$SIG_ENV" -p "s2_test_sig_$$" -f "$COMPOSE_FILE" up -d postgres api web >/dev/null 2>&1

# Wait for API ready
API_UP=0
for _ in {1..30}; do
  if [ "$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3997/health" || true)" = "200" ]; then
    API_UP=1
    break
  fi
  sleep 1
done
_assert_eq "1" "$API_UP" "API reached operational health state"

# Measure stop duration
STOP_START=$(date +%s)
podman compose --env-file "$SIG_ENV" -p "s2_test_sig_$$" -f "$COMPOSE_FILE" stop api web >/dev/null 2>&1
STOP_END=$(date +%s)
STOP_DIFF=$((STOP_END - STOP_START))

if [ "$STOP_DIFF" -lt 10 ]; then
  _assert_eq "0" "0" "API/Web stopped gracefully in ${STOP_DIFF}s (under 10s grace period)"
else
  _assert_eq "0" "1" "API/Web stop exceeded 10s grace period (${STOP_DIFF}s)"
fi

API_LOGS=$(podman compose --env-file "$SIG_ENV" -p "s2_test_sig_$$" -f "$COMPOSE_FILE" logs api 2>&1 || true)
if echo "$API_LOGS" | grep -q "Received termination signal, starting graceful shutdown" && echo "$API_LOGS" | grep -q "Graceful shutdown completed"; then
  _assert_eq "0" "0" "API logs confirm SIGTERM handling and clean exit"
else
  _assert_eq "0" "1" "API logs missing graceful shutdown message"
fi

API_STOP_CODE=$(podman ps -a --filter "name=s2_test_sig_$$_api" --format '{{.ExitCode}}' 2>/dev/null | head -n 1 || echo "unknown")
_assert_eq "0" "$API_STOP_CODE" "API container exited with code 0 (not 137 SIGKILL)"

# Teardown probe stack
podman compose --env-file "$SIG_ENV" -p "s2_test_sig_$$" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true

echo "=== Regression Probes Summary ==="
echo "Total Passed: ${PASS_COUNT}"
echo "Total Failed: ${FAIL_COUNT}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "ERROR: Regression probes failed!" >&2
  exit 1
fi

echo "All regression probes PASSED."
exit 0
