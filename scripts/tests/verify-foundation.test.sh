#!/usr/bin/env bash
# T039 regression phases. Default is controlled; `all` adds real probes only
# after 9-14 pass in this same invocation. Neither phase is source-only approval.
# Historical failed candidates remain in Git: f253269, c70ea70, 558e4b6,
# 74a1eda (Round-3 probes 12/13 failed earlier than their claimed branches).
set -euo pipefail
umask 077
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
VERIFY_SCRIPT="${REPO_ROOT}/scripts/verify-foundation.sh"
COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"
MODE="${1:-controlled}"
case "$MODE" in controlled|all) ;; *) echo 'Expected controlled or all' >&2; exit 1 ;; esac
TEST_ENV_DIR=$(mktemp -d /tmp/s2_verify_regress.XXXXXXXX)
export TEST_ENV_DIR VERIFY_SCRIPT
PASS_COUNT=0
FAIL_COUNT=0
CONTROLLED_COMPLETED=()
# Retain every receipt, call trace and failure. No global trap deletes evidence
# or retries broad Compose teardown after a failed ownership inspection.
trap 'echo "Regression evidence retained: $TEST_ENV_DIR" >&2' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
_assert_eq() {
  if [ "$1" != "$2" ]; then
    echo "[FAIL] $3 (expected '$1', got '$2'); STOP" >&2
    exit 1
  fi
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[PASS] $3"
}
_require_log() {
  local st=0
  grep -F -- "$2" "$1" >/dev/null || st=$?
  _assert_eq 0 "$st" "$3"
}
_forbid_log() {
  local st=0
  grep -F -- "$2" "$1" >/dev/null || st=$?
  _assert_eq 1 "$st" "$3"
}
_require_failure() {
  local receipt="$1" first="$2" cleanup="$3"
  _assert_eq true "$(jq -e --argjson code "$first" --argjson cleanup "$cleanup" \
    '.status == "failed" and .exit_code == $code and .cleanup_failure == $cleanup' "$receipt")" \
    'Mandatory failure receipt has exact exit and cleanup status'
}
_new_env() {
  cat > "$1" <<EOF
COMPOSE_PROJECT_NAME=$2
POSTGRES_DB=s2_foundation_controlled
POSTGRES_USER=s2_controlled
POSTGRES_PASSWORD=controlled_probe_only
COOKIE_SECRET=controlled_probe_only_no_application_is_started
API_HOST_PORT=3981
WEB_HOST_PORT=5981
EOF
}

# Fully controlled command boundary: no `command podman`, provider invocation,
# networking, container creation or fallback. Unrecognized commands are errors.
_controlled_podman() {
  printf 'podman %s\n' "$*" >> "$CASE_DIR/calls"
  local kind id service phase removed token
  phase=$(cat "$CASE_DIR/phase")
  case "$1" in
    compose)
      shift
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --env-file|-p|-f) shift 2 ;;
          *) break ;;
        esac
      done
      case "$*" in
        version) echo 'podman-compose version 1.6.0' ;;
        'up -d postgres') echo running > "$CASE_DIR/phase" ;;
        'exec -T postgres pg_isready '*) return 0 ;;
        'up -d api web') return 0 ;;
        'stop api web') echo stopped > "$CASE_DIR/phase" ;;
        'start api web')
          echo restarted > "$CASE_DIR/phase"
          if [ "$SCENARIO" = cleanup-first47 ]; then return 47; fi ;;
        *) echo "UNEXPECTED compose $*" >> "$CASE_DIR/calls"; return 97 ;;
      esac
      ;;
    ps|network|volume)
      kind="$1"
      if [ "$kind" = ps ]; then kind=container; else
        if [ "${2:-}" = inspect ]; then
          id="$3"
          if [ "$kind" = network ]; then
            local role=default
            if [ "$id" = "$NET2" ]; then role=database; fi
            jq -nc --arg id "$id" --arg run "$TARGETED_RUN_ID" --arg project "$COMPOSE_PROJECT_NAME" --arg role "$role" \
              '[{id:$id,created:"2026-10-20T00:00:00Z",labels:{"io.9gotstory.s2-assets.verify-run":$run,"io.9gotstory.s2-assets.verify-project":$project,"io.9gotstory.s2-assets.verify-resource":$role}}]'
          else
            jq -nc --arg id "$id" --arg run "$TARGETED_RUN_ID" --arg project "$COMPOSE_PROJECT_NAME" \
              '[{Name:$id,CreatedAt:"2026-10-20T00:00:00Z",Labels:{"io.9gotstory.s2-assets.verify-run":$run,"io.9gotstory.s2-assets.verify-project":$project,"io.9gotstory.s2-assets.verify-resource":"postgres-data"}}]'
          fi
          return
        elif [ "${2:-}" = rm ]; then echo "$3" >> "$CASE_DIR/removed"; return 0
        elif [ "${2:-}" = exists ]; then
          if grep -Fx -- "$3" "$CASE_DIR/removed" >/dev/null; then return 1; else return 0; fi
        elif [ "${2:-}" != ls ]; then
          echo "UNEXPECTED $*" >> "$CASE_DIR/calls"; return 97
        fi
      fi
      if [ "$SCENARIO" = "inventory-${kind}" ] && [ "$phase" = preflight ]; then
        echo "inventory_error:${kind}" >> "$CASE_DIR/calls"; return 125
      fi
      if [[ "$SCENARIO" = cleanup-* ]] && [ "$phase" = restarted ]; then
        echo "cleanup_inspection_error:${kind}" >> "$CASE_DIR/calls"; return 125
      fi
      [ "$phase" != preflight ] || return 0
      case "$kind" in
        container) removed="$API_CID $WEB_CID $PG_CID" ;;
        network) removed="$NET1 $NET2" ;;
        volume) removed="${COMPOSE_PROJECT_NAME}_postgres-data" ;;
      esac
      for token in $removed; do
        if ! grep -Fx -- "$token" "$CASE_DIR/removed" >/dev/null; then echo "$token"; fi
      done
      ;;
    container)
      if [ "$2" = exists ]; then
        if [ "$SCENARIO" = absence-error ]; then return 125; fi
        if [ "$SCENARIO" = leak ]; then return 0; fi
        if grep -Fx -- "$3" "$CASE_DIR/removed" >/dev/null; then return 1; else return 0; fi
      fi
      [ "$2" = inspect ] || { echo "UNEXPECTED $*" >> "$CASE_DIR/calls"; return 97; }
      id="$3"
      case "$id" in
        "$API_CID") service=api ;;
        "$WEB_CID") service=web ;;
        "$PG_CID") service=postgres ;;
        *) echo "UNEXPECTED ID $id" >> "$CASE_DIR/calls"; return 97 ;;
      esac
      local running=false status=exited pid=0 code=0 owner="$TARGETED_RUN_ID"
      if [ "$service" = web ]; then code=143; fi
      if [ "$SCENARIO" = terminal-running ] && [ "$phase" = stopped ]; then running=true; status=running; pid=42; fi
      if [ "$SCENARIO" = foreign-owner ]; then owner=foreign; fi
      if [ "$SCENARIO" = ambiguous-service ] && [ "$id" = "$PG_CID" ]; then service=api; fi
      jq -nc --arg id "$id" --arg service "$service" --arg run "$owner" --arg project "$COMPOSE_PROJECT_NAME" \
        --argjson running "$running" --arg status "$status" --argjson pid "$pid" --argjson code "$code" \
        '[{Id:$id,Created:"2026-10-20T00:00:00Z",Config:{Labels:{"io.9gotstory.s2-assets.verify-run":$run,"io.9gotstory.s2-assets.verify-project":$project,"io.9gotstory.s2-assets.verify-service":$service}},State:{Running:$running,Status:$status,Pid:$pid,ExitCode:$code,Paused:false,Restarting:false,Dead:false,OOMKilled:false,FinishedAt:"2026-10-20T00:01:00Z"}}]'
      ;;
    inspect)
      [ "$2" = --format ] && [ "$3" = '{{.State.OOMKilled}}' ] || { echo "UNEXPECTED $*" >> "$CASE_DIR/calls"; return 97; }
      echo "oom:${4}" >> "$CASE_DIR/calls"
      if { [ "$SCENARIO" = oom-api-error ] && [ "$4" = "$API_CID" ]; } || \
        { [ "$SCENARIO" = oom-web-error ] && [ "$4" = "$WEB_CID" ]; }; then return 125; fi
      if [ "$SCENARIO" = oom-true ]; then echo true; else echo false; fi
      ;;
    logs)
      [ "$2" = "$API_CID" ] || return 97
      printf '%s\n' 'Received termination signal, starting graceful shutdown' 'Graceful shutdown completed'
      ;;
    rm) [ "$2" = -f ] || return 97; echo "$3" >> "$CASE_DIR/removed" ;;
    *) echo "UNEXPECTED $*" >> "$CASE_DIR/calls"; return 97 ;;
  esac
}
_controlled_curl() {
  local url="${!#}" phase
  phase=$(cat "$CASE_DIR/phase")
  printf 'curl phase=%s %s\n' "$phase" "$url" >> "$CASE_DIR/calls"
  if [ "$phase" = stopped ]; then
    if { [ "$SCENARIO" = port-api-503 ] && [[ "$url" = */health ]]; } || \
      { [ "$SCENARIO" = port-web-503 ] && [[ "$url" = */login ]]; }; then echo 503; return 0; fi
    if [ "$SCENARIO" = port-timeout ]; then echo 000; return 28; fi
    if [ "$SCENARIO" = port-empty ]; then return 7; fi
    echo 000; return 7
  fi
  case "$url" in
    */auth/session-check) echo 401 ;;
    */health|*/ready|*/login|*/dashboard) echo 200 ;;
    *) echo "UNEXPECTED curl $url" >> "$CASE_DIR/calls"; return 97 ;;
  esac
}
_targeted_case() {
  SCENARIO="$1"
  CASE_DIR="${TEST_ENV_DIR}/${SCENARIO}"
  mkdir -m 700 "$CASE_DIR"
  : > "$CASE_DIR/calls"
  : > "$CASE_DIR/removed"
  echo preflight > "$CASE_DIR/phase"
  _new_env "$CASE_DIR/private.env" "s2_controlled_${SCENARIO//-/_}_$$"
  set +e
  (
    source "$VERIFY_SCRIPT"
    API_CID=$(printf 'a%.0s' {1..64}); WEB_CID=$(printf 'b%.0s' {1..64})
    PG_CID=$(printf 'c%.0s' {1..64}); NET1=$(printf 'd%.0s' {1..64}); NET2=$(printf 'e%.0s' {1..64})
    podman() { _controlled_podman "$@"; }
    podman-compose() { echo 'UNEXPECTED provider invocation' >> "$CASE_DIR/calls"; return 97; }
    curl() { _controlled_curl "$@"; }
    ss() { printf 'ss %s\n' "$*" >> "$CASE_DIR/calls"; return 0; }
    FOUNDATION_ENV_FILE="$CASE_DIR/private.env"
    FOUNDATION_VERIFY_RUN_ID="$SCENARIO"
    export FOUNDATION_VERIFY_RUN_ID
    _run_targeted
  ) > "$CASE_DIR/output" 2>&1
  CASE_EXIT=$?
  set -e
  CASE_RECEIPT="${CASE_DIR}/.verify-${SCENARIO}.json"
  _forbid_log "$CASE_DIR/calls" UNEXPECTED 'No unrecognized command or real-tool fallback'
}

# Probe 9: exclusive project acquisition and preexisting endpoint preservation.
echo 'Controlled Probe 9: exclusive acquisition and collision preservation'
set +e
(
  source "$VERIFY_SCRIPT"
  _acquire_project "s2_controlled_lock_$$" || exit 96
  echo first_acquired
  (
    exec {PROJECT_LOCK_FD}<&-
    if _acquire_project "s2_controlled_lock_$$"; then exit 98; fi
    echo second_refused
    exit 1
  )
) > "$TEST_ENV_DIR/project-lock.output" 2>&1
LOCK_EXIT=$?
set -e
_assert_eq 1 "$LOCK_EXIT" 'Second claim on same project refused'
_require_log "$TEST_ENV_DIR/project-lock.output" first_acquired 'First project claim acquired'
_require_log "$TEST_ENV_DIR/project-lock.output" second_refused 'Collision branch reached'
TOKEN="controlled9_$$"
COLLISION_DIR="/tmp/s2_integ_sock_ci_integ_${TOKEN}"
mkdir -m 700 "$COLLISION_DIR"
echo preexisting > "$COLLISION_DIR/sentinel"
set +e
(
  source "$VERIFY_SCRIPT"
  podman() { echo "UNEXPECTED $*"; return 97; }
  GITHUB_RUN_ID="$TOKEN" TMPDIR="$TEST_ENV_DIR" _run_integration_ci
) > "$TEST_ENV_DIR/p9.output" 2>&1
P9_EXIT=$?
set -e
_assert_eq 1 "$P9_EXIT" 'Endpoint collision rejected'
_require_log "$TEST_ENV_DIR/p9.output" 'Private endpoint directory already exists' 'Actual collision branch reached'
_forbid_log "$TEST_ENV_DIR/p9.output" UNEXPECTED 'No runtime command before collision rejection'
_assert_eq preexisting "$(cat "$COLLISION_DIR/sentinel")" 'Foreign directory preserved'
_require_failure "$TEST_ENV_DIR/.verify_integ_ci_integ_${TOKEN}.json" 1 0
CONTROLLED_COMPLETED+=(9)

# Probe 10: exact owned CID removal, foreign preservation, final absence.
echo 'Controlled Probe 10: integration cleanup ownership'
for ownership in owned foreign absence-error leak; do
  P10_DIR="$TEST_ENV_DIR/p10-$ownership"
  mkdir -m 700 "$P10_DIR"
  : > "$P10_DIR/calls"
  set +e
  (
    source "$VERIFY_SCRIPT"
    _capture_source_identity
    CI_RUN_ID=p10
    CI_RUNNER_NAME=s2_integ_runner_p10
    CI_RUNNER_CID=$(printf 'a%.0s' {1..64})
    CI_STATE_FILE="$P10_DIR/state.json"
    CI_BASELINE_FILE="$P10_DIR/baseline"
    CI_BASELINE_READY=1; CI_MUTATION_STARTED=1; CI_VERIFIED=1
    echo foreign-existing > "${CI_BASELINE_FILE}.container"
    : > "${CI_BASELINE_FILE}.network"; : > "${CI_BASELINE_FILE}.volume"
    podman() {
      echo "$*" >> "$P10_DIR/calls"
      case "$1 $2" in
        'container inspect')
          local owner=p10
          if [ "$ownership" = foreign ]; then owner=someone-else; fi
          jq -nc --arg cid "$CI_RUNNER_CID" --arg owner "$owner" \
            '[{Id:$cid,Name:"s2_integ_runner_p10",Created:"2026-10-20",Config:{Labels:{"io.9gotstory.s2-assets.integ-run":$owner}},State:{Status:"exited",Running:false,Pid:0,ExitCode:0,OOMKilled:false,Restarting:false,Dead:false,Paused:false}}]' ;;
        'rm -f') echo removed > "$P10_DIR/removed" ;;
        'container exists')
          if [ "$ownership" = absence-error ]; then return 125; fi
          if [ "$ownership" = leak ]; then return 0; fi
          if [ -f "$P10_DIR/removed" ]; then return 1; else return 0; fi ;;
        'ps -aq') echo foreign-existing; if [ ! -f "$P10_DIR/removed" ]; then echo "$CI_RUNNER_CID"; fi ;;
        'network ls'|'volume ls') return 0 ;;
        *) echo UNEXPECTED >> "$P10_DIR/calls"; return 97 ;;
      esac
    }
    _cleanup_integration_ci
  ) > "$P10_DIR/output" 2>&1
  P10_EXIT=$?
  set -e
  _forbid_log "$P10_DIR/calls" UNEXPECTED 'No uncontrolled integration cleanup command'
  _forbid_log "$P10_DIR/calls" 'rm -f foreign-existing' 'Foreign resource never removed'
  if [ "$ownership" = owned ]; then
    _assert_eq 0 "$P10_EXIT" 'Owned runner cleaned with verified final absence'
    _require_log "$P10_DIR/calls" 'rm -f aaaaaaaa' 'Full owned CID removed'
    _assert_eq true "$(jq '.status == "passed"' "$P10_DIR/state.json")" 'Cleanup PASS requires receipt'
  elif [ "$ownership" = foreign ]; then
    _assert_eq 1 "$P10_EXIT" 'Foreign runner identity fails closed'
    _forbid_log "$P10_DIR/calls" 'rm -f' 'Foreign runner name cannot authorize removal'
    _require_failure "$P10_DIR/state.json" 1 1
  else
    _assert_eq 1 "$P10_EXIT" 'Removal success cannot replace confirmed absence'
    _require_log "$P10_DIR/calls" 'rm -f aaaaaaaa' 'Owned removal actually attempted'
    _require_log "$P10_DIR/output" 'Runner final absence unverified' 'Final inspection failure branch reached'
    _require_failure "$P10_DIR/state.json" 1 1
  fi
done
CONTROLLED_COMPLETED+=(10)

# Probe 11: each inventory error must reach its own failure branch before up.
echo 'Controlled Probe 11: inventory inspection errors'
for kind in container network volume; do
  _targeted_case "inventory-$kind"
  _assert_eq 1 "$CASE_EXIT" 'Inspection failure exits 1'
  _require_log "$CASE_DIR/calls" "inventory_error:$kind" 'Requested inspection error was injected'
  _require_log "$CASE_DIR/output" "$kind inventory inspection failed" 'Specific inspection branch reached'
  _forbid_log "$CASE_DIR/calls" 'up -d' 'No startup after inspection failure'
  _require_failure "$CASE_RECEIPT" 1 0
done
CONTROLLED_COMPLETED+=(11)

# Probe 12: valid readiness/logs/terminal prerequisites, then exact OOM failure.
echo 'Controlled Probe 12: actual OOM and terminal-state branches'
for scenario in oom-api-error oom-web-error oom-true terminal-running foreign-owner ambiguous-service; do
  _targeted_case "$scenario"
  _assert_eq 1 "$CASE_EXIT" 'Requested ownership/terminal/OOM failure exits 1'
  case "$scenario" in
    oom-api-error|oom-web-error)
      _require_log "$CASE_DIR/output" 'OOM inspection failed for' 'OOM inspection failure branch reached'
      _require_log "$CASE_DIR/output" 'exit code 125' 'Original inspection status retained'
      _assert_eq oom "$(jq -r .failure_phase "$CASE_RECEIPT")" 'Receipt identifies OOM failure phase'
      _require_log "$CASE_DIR/calls" 'oom:' 'OOM inspection actually invoked' ;;
    oom-true) _require_log "$CASE_DIR/output" 'terminated by OOM killer or non-false OOM state' 'OOM true rejected' ;;
    terminal-running) _require_log "$CASE_DIR/output" 'terminal state verification failed' 'Running process rejected despite exit code 0' ;;
    foreign-owner|ambiguous-service) _require_log "$CASE_DIR/output" 'identity or cardinality verification failed' 'Foreign labels rejected' ;;
  esac
  _forbid_log "$CASE_DIR/calls" 'start api web' 'Restart forbidden after intended failure'
  if [ "$scenario" = foreign-owner ]; then _require_failure "$CASE_RECEIPT" 1 1
  else _require_failure "$CASE_RECEIPT" 1 0; fi
done
CONTROLLED_COMPLETED+=(12)

# Probe 13: both OOM checks succeed; only stopped-state curl changes behavior.
echo 'Controlled Probe 13: actual closure branch'
for scenario in port-api-503 port-web-503 port-timeout port-empty; do
  _targeted_case "$scenario"
  _assert_eq 1 "$CASE_EXIT" 'Open or uncertain stopped port fails'
  _require_log "$CASE_DIR/calls" 'oom:aaaaaaaa' 'API OOM prerequisite reached'
  _require_log "$CASE_DIR/calls" 'oom:bbbbbbbb' 'Web OOM prerequisite reached'
  _require_log "$CASE_DIR/calls" 'curl phase=stopped' 'Stopped closure probe actually invoked'
  _require_log "$CASE_DIR/output" 'Stopped service closure verification failed' 'Closure failure branch reached'
  _assert_eq closure "$(jq -r .failure_phase "$CASE_RECEIPT")" 'Receipt identifies closure failure phase'
  _forbid_log "$CASE_DIR/calls" 'start api web' 'Restart forbidden after closure failure'
  _require_failure "$CASE_RECEIPT" 1 0
done
# Paired positive control prevents a stub that can only fail before restart.
_targeted_case healthy
_assert_eq 0 "$CASE_EXIT" 'Valid controlled lifecycle reaches success'
_require_log "$CASE_DIR/calls" 'start api web' 'Positive control reaches restart'
_assert_eq true "$(jq '.status == "passed"' "$CASE_RECEIPT")" 'Positive control has mandatory PASS receipt'
CONTROLLED_COMPLETED+=(13)

# Probe 14: cleanup inspection errors, first failure and directory replacement.
echo 'Controlled Probe 14: cleanup failure receipts and evidence retention'
for scenario in cleanup-inspection cleanup-first47 absence-error leak; do
  _targeted_case "$scenario"
  expected=1
  if [ "$scenario" = cleanup-first47 ]; then expected=47; fi
  _assert_eq "$expected" "$CASE_EXIT" 'First failure preserved independently of cleanup failure'
  if [[ "$scenario" = cleanup-* ]]; then
    _require_log "$CASE_DIR/calls" cleanup_inspection_error 'Actual cleanup inspection failed'
  else
    _require_log "$CASE_DIR/output" 'Final absence unverified' 'Removal cannot conceal failed final inspection'
  fi
  _require_failure "$CASE_RECEIPT" "$expected" 1
  if [ "$expected" = 47 ]; then
    _assert_eq 47 "$(jq .exit_code "${CASE_RECEIPT}.first-failure")" 'Immutable original failure retained'
  fi
done
P14_DIR="$TEST_ENV_DIR/inode-mismatch"
mkdir -m 700 "$P14_DIR"
echo retain > "$P14_DIR/sentinel"
set +e
(
  source "$VERIFY_SCRIPT"
  _capture_source_identity
  CI_RUN_ID=p14; CI_VERIFIED=1
  CI_RUN_DIR="$P14_DIR"; CI_RUN_DIR_CREATED=1; CI_RUN_DIR_INODE=wrong
  CI_STATE_FILE="$TEST_ENV_DIR/p14.json"
  podman() { echo UNEXPECTED; return 97; }
  _cleanup_integration_ci
) > "$TEST_ENV_DIR/p14.output" 2>&1
P14_EXIT=$?
set -e
_assert_eq 1 "$P14_EXIT" 'Directory identity mismatch fails cleanup'
_require_log "$TEST_ENV_DIR/p14.output" 'Cleanup identity mismatch' 'Directory mismatch branch reached'
_assert_eq retain "$(cat "$P14_DIR/sentinel")" 'Replacement directory retained'
_require_failure "$TEST_ENV_DIR/p14.json" 1 1
CONTROLLED_COMPLETED+=(14)

_assert_eq '9 10 11 12 13 14' "${CONTROLLED_COMPLETED[*]}" 'Complete controlled gate before real verification'
echo 'Controlled Probes 9-14 PASSED'
if [ "$MODE" = controlled ]; then exit 0; fi

echo 'Entering real verification after complete controlled PASS'
export PODMAN_COMPOSE_PROVIDER="${PODMAN_COMPOSE_PROVIDER:-podman-compose}"
# Legacy probes 1-7 retain their original checks and failure receipts.
# Directories remain private and are retained for independent review.
CLEANUP_DIRS=()
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
source "${VERIFY_SCRIPT}"

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
INJ_HASH_BEFORE=$(sha256sum "$INJ_STATE")
set +e
REUSE_OUTPUT=$(FOUNDATION_ENV_FILE="$INJECT_ENV" FOUNDATION_VERIFY_RUN_ID="test_inj_run" "${VERIFY_SCRIPT}" targeted 2>&1)
EXIT_REUSE=$?
set -e
_assert_eq "1" "$EXIT_REUSE" "Reuse of failed run ID refused with nonzero exit"

REUSE_CODE=$(grep -o '"exit_code":[0-9]*' "$INJ_STATE" | cut -d':' -f2 || true)
_assert_eq "47" "$REUSE_CODE" "Receipt exit_code 47 preserved unchanged after reuse refusal"
_assert_eq "$INJ_HASH_BEFORE" "$(sha256sum "$INJ_STATE")" 'Failed receipt preserved byte-for-byte after reuse refusal'


# Probe 8 runs the same exact-ownership lifecycle that Probes 11-14 exercise.
echo 'Real Probe 8: exact ownership, terminal state, closure, restart and cleanup'
SIG_ENV="$TEST_ENV_DIR/sig.env"
SIG_PROJ="s2_test_sig_$$"
cat > "$SIG_ENV" <<EOF
COMPOSE_PROJECT_NAME=$SIG_PROJ
POSTGRES_DB=s2_foundation_sig_$$
POSTGRES_USER=s2_sig_user
POSTGRES_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
API_HOST_PORT=3997
WEB_HOST_PORT=5997
EOF
set +e
FOUNDATION_ENV_FILE="$SIG_ENV" FOUNDATION_VERIFY_RUN_ID="real_signal_$$" "$VERIFY_SCRIPT" targeted \
  > "$TEST_ENV_DIR/probe8.output" 2>&1
P8_EXIT=$?
set -e
_assert_eq 0 "$P8_EXIT" 'Real lifecycle exits successfully'
P8_STATE="$TEST_ENV_DIR/.verify-real_signal_$$.json"
_assert_eq true "$(jq '.status == "passed"' "$P8_STATE")" 'Real lifecycle PASS receipt mandatory'
# Targeted mode preserves data. This disposable probe separately acquires the
# same project lock and deletes only the volume matching the retained receipt.
(
  source "$VERIFY_SCRIPT"
  _capture_source_identity
  COMPOSE_PROJECT_NAME="$SIG_PROJ"
  TARGETED_RUN_ID="real_signal_$$"
  _acquire_project "$COMPOSE_PROJECT_NAME" || _fail 'ERROR: Probe volume project claim refused'
  volume_receipt=$(jq -ces 'map(select(.kind == "volume")) |
    if length == 1 then .[0] else error("volume cardinality") end' "${P8_STATE}.resources")
  volume_name=$(jq -r .id <<< "$volume_receipt")
  current=$(_project_resource volume "$volume_name")
  [ "$current" = "$volume_receipt" ] || _fail 'ERROR: Probe volume identity changed'
  podman volume rm "$volume_name"
  st=0
  podman volume exists "$volume_name" || st=$?
  [ "$st" -eq 1 ] || _fail "ERROR: Probe volume absence unverified (exit $st)"
  printf 'absent volume %s\n' "$volume_name" >> "${P8_STATE}.cleanup"
)
_require_log "${P8_STATE}.cleanup" 'absent volume ' 'Disposable volume absence receipt mandatory'
_require_log "${P8_STATE}.cleanup" 'absent container ' 'Container absence receipts present'
_require_log "${P8_STATE}.cleanup" 'absent network ' 'Network absence receipts present'
echo "Real Probe 8 passed; evidence retained: $P8_STATE"
echo "Regression assertions passed: $PASS_COUNT"
