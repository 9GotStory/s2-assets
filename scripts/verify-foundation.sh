#!/usr/bin/env bash
# scripts/verify-foundation.sh — Fixed-purpose verification runner for Application Foundation
# Modes: 'targeted' (local disposable lifecycle & signal verification) or 'integration-ci' (safe private-endpoint CI integration)

set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
COMPOSE_FILE="${REPO_ROOT}/deploy/podman/compose.yaml"

APPROVED_BASELINE_SHA="98be44f1a85ed1cc7d786ebbd03566cb8d5bc5e6"
# The previous Round-3 candidate's parent was 558e4b6fdbed36d109cfcbc796e63e6f918bba2d.
# New receipts identify the actual tested checkout; old receipts are never reused.
APPROVED_PARENT_SHA=""
TESTED_SHA=""
OWNER_LABEL="io.9gotstory.s2-assets.verify-run"
PROJECT_LABEL="io.9gotstory.s2-assets.verify-project"
SERVICE_LABEL="io.9gotstory.s2-assets.verify-service"
PROJECT_LOCK_FD=""
TARGETED_RESOURCES=""
TARGETED_API_CID=""
TARGETED_WEB_CID=""
CI_RUNNER_CID=""
CI_ENDPOINT_IDENTITY=""
CI_SOCKET_IDENTITY=""

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
TARGETED_PHASE=preflight
TARGETED_FAILURE_PHASE=""

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
  file_mode=$(stat -c "%a" "$FOUNDATION_ENV_FILE" 2>/dev/null || stat -f "%OLp" "$FOUNDATION_ENV_FILE" 2>/dev/null) || _fail "ERROR: Environment permission inspection failed"
  [ -n "$file_mode" ] || _fail "ERROR: Empty environment permission inspection"
  if [ -n "$file_mode" ]; then
    file_tail="${file_mode: -2}"
    if [ "$file_tail" != "00" ]; then
      _fail "ERROR: Insecure permissions on ${FOUNDATION_ENV_FILE}: mode must be 600 or 400 (got ${file_mode})"
    fi
  fi

  ENV_DIR=$(dirname "$FOUNDATION_ENV_FILE")
  local dir_mode dir_tail
  dir_mode=$(stat -c "%a" "$ENV_DIR" 2>/dev/null || stat -f "%OLp" "$ENV_DIR" 2>/dev/null) || _fail "ERROR: Environment directory permission inspection failed"
  [ -n "$dir_mode" ] || _fail "ERROR: Empty directory permission inspection"
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

# Ownership checks use explicit Compose labels, never name-prefix deletion.
_capture_source_identity() {
  TESTED_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
  APPROVED_PARENT_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD^)
  command -v jq >/dev/null || _fail "ERROR: jq is required for checked resource receipts"
}

_acquire_project() {
  local project="$1" lock_root lock_file identity
  lock_root="/tmp/.s2-verify-locks-$(id -u)"
  if [ ! -e "$lock_root" ] && [ ! -L "$lock_root" ]; then
    mkdir -m 700 "$lock_root" || return 1
  fi
  [ ! -L "$lock_root" ] && [ -d "$lock_root" ] || return 1
  identity=$(stat -c '%u:%a' "$lock_root") || return 1
  [ "$identity" = "$(id -u):700" ] || return 1
  lock_file="${lock_root}/${project}.lock"
  if [ ! -e "$lock_file" ] && [ ! -L "$lock_file" ]; then
    (umask 077; set -o noclobber; : > "$lock_file") || return 1
  fi
  [ ! -L "$lock_file" ] && [ -f "$lock_file" ] || return 1
  identity=$(stat -c '%u:%a:%d:%i' "$lock_file") || return 1
  [[ "$identity" = "$(id -u):600:"* ]] || return 1
  exec {PROJECT_LOCK_FD}< "$lock_file" || return 1
  [ "$(stat -Lc '%u:%a:%d:%i' "/proc/${BASHPID}/fd/$PROJECT_LOCK_FD")" = "$identity" ] || return 1
  flock -n "$PROJECT_LOCK_FD" || return 1
  # Keep the inode permanently: unlinking lock files permits concurrent owners.
}

_project_inventory() {
  local kind="$1"
  case "$kind" in
    container) podman ps -aq --no-trunc --filter "label=${PROJECT_LABEL}=${COMPOSE_PROJECT_NAME}" ;;
    network) podman network ls --no-trunc --filter "label=${PROJECT_LABEL}=${COMPOSE_PROJECT_NAME}" --format '{{.ID}}' ;;
    volume) podman volume ls --filter "label=${PROJECT_LABEL}=${COMPOSE_PROJECT_NAME}" --format '{{.Name}}' ;;
    *) return 1 ;;
  esac
}

_project_resource() {
  local kind="$1" id="$2" raw
  raw=$(podman "$kind" inspect "$id") || return 1
  # Emit only non-secret fields. Never retain Config.Env or raw inspect output.
  jq -ce --arg kind "$kind" --arg run "$TARGETED_RUN_ID" \
    --arg project "$COMPOSE_PROJECT_NAME" --arg owner "$OWNER_LABEL" \
    --arg pl "$PROJECT_LABEL" --arg sl "$SERVICE_LABEL" '
    if type != "array" or length != 1 then error("ambiguous inspection") else .[0] end |
    (if $kind == "container" then .Config.Labels else (.Labels // .labels) end) as $labels |
    select($labels[$owner] == $run and $labels[$pl] == $project) |
    if $kind == "container" then
      select(.Id | test("^[a-f0-9]{64}$")) |
      select(.Created | type == "string" and length > 0) |
      select($labels[$sl] == "api" or $labels[$sl] == "web" or $labels[$sl] == "postgres") |
      {kind:$kind,id:.Id,created:.Created,service:$labels[$sl],run:$run,project:$project}
    elif $kind == "network" then
      select(.id | test("^[a-f0-9]{64}$")) |
      select(.created | type == "string" and length > 0) |
      select($labels["io.9gotstory.s2-assets.verify-resource"] == "default" or
        $labels["io.9gotstory.s2-assets.verify-resource"] == "database") |
      {kind:$kind,id:.id,created:.created,resource:$labels["io.9gotstory.s2-assets.verify-resource"],run:$run,project:$project}
    else
      select(.Name | type == "string" and length > 0) |
      select(.CreatedAt | type == "string" and length > 0) |
      select($labels["io.9gotstory.s2-assets.verify-resource"] == "postgres-data") |
      {kind:$kind,id:.Name,created:.CreatedAt,resource:"postgres-data",run:$run,project:$project}
    end' <<< "$raw"
}

_reject_project_name_collisions() {
  local names name kind
  for kind in container network volume; do
    case "$kind" in
      container) names=$(podman ps -a --format '{{.Names}}') || return 1 ;;
      network) names=$(podman network ls --format '{{.Name}}') || return 1 ;;
      volume) names=$(podman volume ls --format '{{.Name}}') || return 1 ;;
    esac
    for name in $names; do
      if [[ "$name" = "$COMPOSE_PROJECT_NAME" || "$name" = "${COMPOSE_PROJECT_NAME}_"* || "$name" = "${COMPOSE_PROJECT_NAME}-"* ]]; then
        echo "ERROR: Existing resource in requested project namespace: $kind $name" >&2
        return 1
      fi
    done
  done
}

_verify_project_manifest() {
  local row kind id current
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    kind=$(jq -r .kind <<< "$row") || return 1
    id=$(jq -r .id <<< "$row") || return 1
    current=$(_project_resource "$kind" "$id") || return 1
    [ "$current" = "$row" ] || return 1
  done < "$TARGETED_RESOURCES"
  _capture_project_resources || return 1
  _require_project_cardinality
}

_capture_project_resources() {
  local kind ids id receipt old
  for kind in container network volume; do
    ids=$(_project_inventory "$kind") || return 1
    for id in $ids; do
      receipt=$(_project_resource "$kind" "$id") || return 1
      old=$(jq -cs --arg kind "$kind" --arg id "$(jq -r .id <<< "$receipt")" \
        'map(select(.kind == $kind and .id == $id))' "$TARGETED_RESOURCES") || return 1
      if [ "$old" = '[]' ]; then
        printf '%s\n' "$receipt" >> "$TARGETED_RESOURCES" || return 1
      else
        [ "$(jq -c '.[0]' <<< "$old")" = "$receipt" ] || return 1
      fi
    done
  done
}

_require_project_cardinality() {
  local service ids
  for service in postgres api web; do
    ids=$(jq -cs --arg service "$service" 'map(select(.kind == "container" and .service == $service)) |
      if length == 1 then .[0].id else error("service cardinality") end' "$TARGETED_RESOURCES") || return 1
    case "$service" in
      api) TARGETED_API_CID=$(jq -r . <<< "$ids") ;;
      web) TARGETED_WEB_CID=$(jq -r . <<< "$ids") ;;
    esac
  done
  jq -es 'map(select(.kind == "network")) |
    length == 2 and (map(.resource) | sort == ["database","default"])' "$TARGETED_RESOURCES" >/dev/null || return 1
  jq -es 'map(select(.kind == "volume")) | length == 1' "$TARGETED_RESOURCES" >/dev/null
}

_service_terminal() {
  local cid="$1" service="$2" receipt raw state
  receipt=$(_project_resource container "$cid") || return 1
  [ "$(jq -r .service <<< "$receipt")" = "$service" ] || return 1
  raw=$(podman container inspect "$cid") || return 1
  state=$(jq -ce --arg cid "$cid" '
    select(length == 1 and .[0].Id == $cid) | .[0].State |
    select(.Running == false and .Status == "exited" and .Pid == 0 and
      .Paused == false and .Restarting == false and .Dead == false) |
    {Running,Status,Pid,Paused,Restarting,Dead,ExitCode,FinishedAt}' <<< "$raw") || return 1
  jq -c --arg cid "$cid" --arg service "$service" '. + {cid:$cid,service:$service}'     <<< "$state" >> "${TARGETED_STATE_FILE}.terminal" || return 1
  local code
  code=$(jq -er '.ExitCode | select(type == "number")' <<< "$state") || return 1
  if [ "$service" = api ]; then [ "$code" = 0 ] || return 1
  else [ "$code" = 0 ] || [ "$code" = 143 ] || return 1; fi
  printf '%s\n' "$code"
}

_require_port_closed() {
  local port="$1" path="$2" code st=0 listeners
  code=$(curl -s --connect-timeout 1 --max-time 1 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:${port}/${path}") || st=$?
  if [ "$code" != 000 ] || [ "$st" -ne 7 ]; then
    echo "ERROR: Port closure failed for ${port}: HTTP=${code}, curl_exit=${st}" >&2
    return 1
  fi
  listeners=$(ss -H -ltn "sport = :${port}") || return 1
  [ -z "$listeners" ] || return 1
  printf 'closed port=%s curl_exit=%s http=%s listeners=0\n' "$port" "$st" "$code" \
    >> "${TARGETED_STATE_FILE}.terminal"
}

_cleanup_project_resources() {
  local failed=0 kind records row id current st ids
  # Even partial startup must prove labels before adoption or deletion.
  if ! _capture_project_resources; then
    echo 'ERROR: Project cleanup ownership inspection failed; retaining resources' >&2
    return 1
  fi
  if [ "$TARGETED_PHASE4_PASSED" -eq 1 ] && ! _require_project_cardinality; then
    echo 'ERROR: Final project cardinality changed; retaining resources' >&2
    return 1
  fi
  for kind in container network volume; do
    records=$(jq -cs --arg kind "$kind" 'map(select(.kind == $kind)) | .[]' "$TARGETED_RESOURCES") || return 1
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      id=$(jq -r .id <<< "$row") || return 1
      current=$(_project_resource "$kind" "$id") || { failed=1; continue; }
      if [ "$current" != "$row" ]; then
        echo "ERROR: Cleanup identity changed for $kind $id" >&2
        failed=1
        continue
      fi
      # Targeted mode preserves its exact data volume, including after failure.
      if [ "$kind" = volume ]; then
        printf 'preserved %s\n' "$row" >> "${TARGETED_STATE_FILE}.cleanup" || failed=1
        continue
      fi
      if [ "$kind" = container ]; then
        podman rm -f "$id" || { failed=1; continue; }
      else
        podman network rm "$id" || { failed=1; continue; }
      fi
      st=0
      podman "$kind" exists "$id" || st=$?
      if [ "$st" != 1 ]; then
        echo "ERROR: Final absence unverified for $kind $id (exit $st)" >&2
        failed=1
      else
        printf 'absent %s %s\n' "$kind" "$id" >> "${TARGETED_STATE_FILE}.cleanup" || failed=1
      fi
    done <<< "$records"
    ids=$(_project_inventory "$kind") || { failed=1; continue; }
    if [ "$kind" != volume ] && [ -n "$ids" ]; then failed=1; fi
  done
  records=$(jq -cs 'map(select(.kind != "volume")) | .[]' "$TARGETED_RESOURCES") || return 1
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    kind=$(jq -r .kind <<< "$row") || return 1
    id=$(jq -r .id <<< "$row") || return 1
    st=0
    podman "$kind" exists "$id" || st=$?
    if [ "$st" -ne 1 ]; then failed=1; fi
  done <<< "$records"
  [ "$failed" = 0 ]
}

# --- Mode: targeted ---

# Pending files are not authoritative receipts. Permission and write failures
# must leave the canonical running/failed receipt intact. Rename is the final
# required operation: there is no fallible chmod after publishing PASS.
_publish_final_receipt() {
  local state_file="$1" pending="" timestamp st
  if pending=$(mktemp "${state_file}.pending.XXXXXXXX"); then
    if timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) && chmod 600 "$pending" &&
      jq -ec --arg timestamp "$timestamp" '.timestamp = $timestamp' > "$pending" &&
      mv -T -- "$pending" "$state_file"; then
      return 0
    else
      st=$?
    fi
  else
    st=$?
  fi
  # Retain the pending file and existing first-failure/cleanup evidence.
  printf 'receipt_finalization_failed exit=%s pending=%s\n' "$st" "$pending" \
    >> "${state_file}.cleanup" || echo 'ERROR: Could not persist receipt finalization error' >&2
  echo "ERROR: Receipt finalization failed (exit $st); canonical receipt was not replaced: $state_file" >&2
  return 1
}

_record_targeted_failure() {
  local code="${1:-1}"
  if [ "${TARGETED_REUSE_REFUSED:-0}" -eq 1 ]; then
    return
  fi
  if [ "$TARGETED_FIRST_FAILURE" -eq 0 ]; then
    TARGETED_FIRST_FAILURE="$code"
    TARGETED_FAILURE_PHASE="$TARGETED_PHASE"
    if [ -n "${TARGETED_STATE_FILE:-}" ]; then
      cat <<EOF > "$TARGETED_STATE_FILE" || TARGETED_CLEANUP_FAILURE=1
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","failure_phase":"${TARGETED_FAILURE_PHASE}","exit_code":${TARGETED_FIRST_FAILURE},"cleanup_failure":${TARGETED_CLEANUP_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$TARGETED_STATE_FILE" || TARGETED_CLEANUP_FAILURE=1
      (umask 077; set -o noclobber; cat "$TARGETED_STATE_FILE" > "${TARGETED_STATE_FILE}.first-failure") || TARGETED_CLEANUP_FAILURE=1
    fi
  fi
}

_cleanup_targeted() {
  local exit_code="$?"
  trap - EXIT INT TERM
  set +e

  if [ "${TARGETED_REUSE_REFUSED:-0}" -eq 1 ]; then
    exit "$exit_code"
  fi

  if [ "$exit_code" -ne 0 ] && [ "$TARGETED_FIRST_FAILURE" -eq 0 ]; then
    _record_targeted_failure "$exit_code"
  fi

  echo "--- Phase 5: Exact-Owned Cleanup ---"
  if [ "$TARGETED_MUTATION_STARTED" -eq 1 ]; then
    if ! _cleanup_project_resources; then TARGETED_CLEANUP_FAILURE=1; fi
  fi

  # Record final durable state
  if [ "${TARGETED_REUSE_REFUSED:-0}" -eq 0 ] && [ -n "${TARGETED_STATE_FILE:-}" ]; then
    if [ "$TARGETED_FIRST_FAILURE" -eq 0 ] && [ "$TARGETED_CLEANUP_FAILURE" -eq 0 ] && [ "$TARGETED_PHASE4_PASSED" -eq 1 ]; then
      _publish_final_receipt "$TARGETED_STATE_FILE" <<EOF || TARGETED_CLEANUP_FAILURE=1
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"passed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","api_exit":"${TARGETED_API_EXIT}","web_exit":"${TARGETED_WEB_EXIT}"}
EOF
    fi
    if [ "$TARGETED_FIRST_FAILURE" -ne 0 ] || [ "$TARGETED_CLEANUP_FAILURE" -ne 0 ] || [ "$TARGETED_PHASE4_PASSED" -ne 1 ]; then
      local final_code="$TARGETED_FIRST_FAILURE"
      if [ "$final_code" -eq 0 ]; then final_code=1; TARGETED_FAILURE_PHASE=cleanup; fi
      _publish_final_receipt "$TARGETED_STATE_FILE" <<EOF || TARGETED_CLEANUP_FAILURE=1
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","failure_phase":"${TARGETED_FAILURE_PHASE}","exit_code":${final_code},"cleanup_failure":${TARGETED_CLEANUP_FAILURE}}
EOF
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

  [ "$TARGETED_PHASE4_PASSED" -eq 1 ] || exit 1
  exit 0
}

_run_targeted() {
  echo "=== Running Fixed-Purpose Verification: Mode 'targeted' ==="

  # Phase 1: Authority & Baseline
  echo "--- Phase 1: Authority and Baseline Validation ---"
  _capture_source_identity
  _validate_foundation_env_file

  if [ -z "${FOUNDATION_VERIFY_RUN_ID:-}" ]; then
    _fail "ERROR: FOUNDATION_VERIFY_RUN_ID is required for mode 'targeted'"
  fi
  if [[ ! "$FOUNDATION_VERIFY_RUN_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    _fail "ERROR: FOUNDATION_VERIFY_RUN_ID must be alphanumeric with hyphens or underscores: ${FOUNDATION_VERIFY_RUN_ID}"
  fi

  [ "$FOUNDATION_VERIFY_RUN_ID" != unclaimed ] || _fail "ERROR: Unclaimed run ID is reserved"
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
{"run_id":"${TARGETED_RUN_ID}","mode":"targeted","status":"running","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
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
  clean_version=$(podman compose version 2>&1 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g')
  if ! echo "${clean_version}" | grep -Eq "^podman-compose version 1\.6\.0[[:space:]]*$"; then
    _record_targeted_failure 1
    _fail "ERROR: Requires podman-compose 1.6.0"
  fi

  if ! _acquire_project "$COMPOSE_PROJECT_NAME"; then
    _record_targeted_failure 1
    _fail "ERROR: Exclusive project acquisition refused"
  fi
  TARGETED_RESOURCES="${TARGETED_STATE_FILE}.resources"
  (umask 077; set -o noclobber; : > "$TARGETED_RESOURCES")
  local kind existing
  for kind in container network volume; do
    existing=$(_project_inventory "$kind") || {
      _record_targeted_failure 1
      _fail "ERROR: ${kind} inventory inspection failed"
    }
    if [ -n "$existing" ]; then
      _record_targeted_failure 1
      _fail "ERROR: Preexisting ${kind} resources detected for project"
    fi
  done

  if ! _reject_project_name_collisions; then
    _record_targeted_failure 1
    _fail "ERROR: Project namespace collision or inspection failure"
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
  TARGETED_PHASE=startup
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
  if ! _capture_project_resources || ! _require_project_cardinality; then
    _record_targeted_failure 1
    _fail "ERROR: Exact project identity or cardinality verification failed"
  fi

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
  if ! _verify_project_manifest; then
    _record_targeted_failure 1
    _fail "ERROR: Project identity changed before stop"
  fi
  stop_start=$(date +%s)
  podman compose --env-file "$FOUNDATION_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" stop api web
  stop_end=$(date +%s)
  stop_duration=$((stop_end - stop_start))
  echo "Stop completed in ${stop_duration}s."
  if [ "$stop_duration" -ge 10 ]; then
    _record_targeted_failure 1
    _fail "ERROR: Service stop duration (${stop_duration}s) exceeded 10-second grace period!"
  fi

  TARGETED_PHASE=terminal
  # Check logs for graceful shutdown
  local api_logs
  api_logs=$(podman logs "$TARGETED_API_CID") || {
    _record_targeted_failure 1
    _fail "ERROR: API shutdown log inspection failed"
  }
  if ! echo "$api_logs" | grep -q "Received termination signal, starting graceful shutdown" || ! echo "$api_logs" | grep -q "Graceful shutdown completed"; then
    _record_targeted_failure 1
    _fail "ERROR: API logs did not capture required graceful shutdown completion messages!"
  fi
  echo "Verified: API received SIGTERM and executed graceful shutdown handlers."

  local api_exit web_exit api_cid="$TARGETED_API_CID" web_cid="$TARGETED_WEB_CID"
  api_exit=$(_service_terminal "$api_cid" api) || {
    _record_targeted_failure 1
    _fail "ERROR: API terminal state verification failed"
  }
  web_exit=$(_service_terminal "$web_cid" web) || {
    _record_targeted_failure 1
    _fail "ERROR: Web terminal state verification failed"
  }
  TARGETED_PHASE=oom
  local api_oom web_oom api_oom_st=0 web_oom_st=0
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

  printf 'api_oom=%s web_oom=%s\n' "$api_oom" "$web_oom" >> "${TARGETED_STATE_FILE}.terminal"
  if [ "$api_oom" != "false" ] || [ "$web_oom" != "false" ]; then
    _record_targeted_failure 1
    _fail "ERROR: Service container was terminated by OOM killer or non-false OOM state (api_oom=${api_oom}, web_oom=${web_oom})"
  fi

  TARGETED_PHASE=closure
  if ! _require_port_closed "$API_HOST_PORT" health || ! _require_port_closed "$WEB_HOST_PORT" login; then
    _record_targeted_failure 1
    _fail "ERROR: Stopped service closure verification failed"
  fi

  if ! _verify_project_manifest; then
    _record_targeted_failure 1
    _fail "ERROR: Project identity changed before restart"
  fi
  TARGETED_PHASE=restart
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
      cat <<EOF > "$CI_STATE_FILE" || CI_CLEANUP_FAILURE=1
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","exit_code":${CI_FIRST_FAILURE},"cleanup_failure":${CI_CLEANUP_FAILURE},"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
      chmod 600 "$CI_STATE_FILE" || CI_CLEANUP_FAILURE=1
      (umask 077; set -o noclobber; cat "$CI_STATE_FILE" > "${CI_STATE_FILE}.first-failure") || CI_CLEANUP_FAILURE=1
    fi
  fi
}

_ci_inventory() {
  case "$1" in
    container) podman ps -aq --no-trunc ;;
    network) podman network ls --no-trunc --format '{{.ID}}' ;;
    volume) podman volume ls --format '{{.Name}}' ;;
    *) return 1 ;;
  esac
}

_ci_runner_receipt() {
  local raw
  raw=$(podman container inspect "$1") || return 1
  jq -ce --arg cid "$1" --arg run "$CI_RUN_ID" --arg name "$CI_RUNNER_NAME" '
    select(length == 1) | .[0] |
    select(.Id == $cid and .Name == $name and .Config.Labels["io.9gotstory.s2-assets.integ-run"] == $run) |
    {id:.Id,name:.Name,created:.Created,state:(.State | {Status,Running,Pid,ExitCode,OOMKilled,Restarting,Dead,Paused,FinishedAt})}' <<< "$raw"
}

_endpoint_identity() {
  local pid="$1" started uid
  # Linux host contract: /proc start time distinguishes reused PIDs.
  started=$(awk '{print $22}' "/proc/${pid}/stat") || return 1
  uid=$(stat -c '%u' "/proc/${pid}") || return 1
  [ "$uid" = "$(id -u)" ] && [[ "$started" =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s\n' "$uid" "$started"
}

_stop_owned_endpoint() {
  local identity state stopped=0 status=0
  if [ -z "$CI_ENDPOINT_IDENTITY" ]; then
    echo 'ERROR: Endpoint process identity unavailable; refusing signal' >&2
    return 1
  fi
  if [ -e "/proc/${CI_ENDPOINT_PID}" ]; then
    identity=$(_endpoint_identity "$CI_ENDPOINT_PID") || return 1
    [ "$identity" = "$CI_ENDPOINT_IDENTITY" ] || return 1
    kill -TERM "$CI_ENDPOINT_PID" || return 1
    for _ in {1..30}; do
      if [ ! -e "/proc/${CI_ENDPOINT_PID}" ]; then stopped=1; break; fi
      identity=$(_endpoint_identity "$CI_ENDPOINT_PID") || return 1
      [ "$identity" = "$CI_ENDPOINT_IDENTITY" ] || return 1
      state=$(awk '{print $3}' "/proc/${CI_ENDPOINT_PID}/stat") || return 1
      if [ "$state" = Z ]; then stopped=1; break; fi
      sleep 0.2
    done
    if [ "$stopped" -ne 1 ]; then
      echo 'ERROR: Endpoint termination timeout; retaining endpoint evidence' >&2
      return 1
    fi
  fi
  wait "$CI_ENDPOINT_PID" || status=$?
  [ "$status" = 0 ] || [ "$status" = 143 ] || return 1
  [ ! -e "/proc/${CI_ENDPOINT_PID}" ] || return 1
  printf 'endpoint_pid=%s identity=%s wait_exit=%s process_absent=true\n' \
    "$CI_ENDPOINT_PID" "$CI_ENDPOINT_IDENTITY" "$status" >> "${CI_STATE_FILE}.cleanup"
}

_cleanup_integration_ci() {
  local exit_code="$?"
  trap - EXIT INT TERM
  set +e

  if [ "${CI_REUSE_REFUSED:-0}" -eq 1 ]; then
    exit "$exit_code"
  fi

  if [ "$exit_code" -ne 0 ] && [ "$CI_FIRST_FAILURE" -eq 0 ]; then
    _record_ci_failure "$exit_code"
  fi

  echo "--- Phase 5: Exact-Owned Cleanup (integration-ci) ---"

  local directory_trusted=1 identity=""
  if [ "$CI_RUN_DIR_CREATED" -eq 1 ]; then
    identity=$(stat -c '%d:%i:%u' "$CI_RUN_DIR") || directory_trusted=0
    if [ -L "$CI_RUN_DIR" ] || [ "$identity" != "$CI_RUN_DIR_INODE" ]; then directory_trusted=0; fi
    if [ "$directory_trusted" -ne 1 ]; then
      echo 'ERROR: Cleanup identity mismatch for endpoint directory; retaining it' >&2
      CI_CLEANUP_FAILURE=1
    fi
  fi

  # Only a full ID captured by this invocation can authorize runner removal.
  if [ "$CI_MUTATION_STARTED" -eq 1 ] && [ "$directory_trusted" -eq 1 ]; then
    if [ -z "$CI_RUNNER_CID" ] && [ -f "${CI_RUN_DIR}/runner.cid" ]; then
      CI_RUNNER_CID=$(cat "${CI_RUN_DIR}/runner.cid") || CI_CLEANUP_FAILURE=1
    fi
    local proof st=0
    if [[ "$CI_RUNNER_CID" =~ ^[a-f0-9]{64}$ ]]; then
      proof=$(_ci_runner_receipt "$CI_RUNNER_CID") || CI_CLEANUP_FAILURE=1
      if [ "$CI_FIRST_FAILURE" -eq 0 ] && [ "$CI_VERIFIED" -eq 1 ]; then
        if ! jq -e '.state | .Running == false and .Status == "exited" and .Pid == 0 and
          .ExitCode == 0 and .OOMKilled == false and .Restarting == false and .Dead == false and .Paused == false'           <<< "$proof" >/dev/null; then CI_CLEANUP_FAILURE=1; fi
      fi
      if [ "$CI_CLEANUP_FAILURE" -eq 0 ]; then
        printf '%s\n' "$proof" >> "${CI_STATE_FILE}.cleanup" || CI_CLEANUP_FAILURE=1
        if ! podman rm -f "$CI_RUNNER_CID"; then CI_CLEANUP_FAILURE=1; fi
        podman container exists "$CI_RUNNER_CID" || st=$?
        if [ "$st" -ne 1 ]; then
          echo "ERROR: Runner final absence unverified (exit $st)" >&2
          CI_CLEANUP_FAILURE=1
        else
          printf 'absent container %s\n' "$CI_RUNNER_CID" >> "${CI_STATE_FILE}.cleanup" || CI_CLEANUP_FAILURE=1
        fi
      fi
    else
      echo 'ERROR: Runner full ID unavailable; refusing name-based cleanup' >&2
      CI_CLEANUP_FAILURE=1
    fi
  fi

  # A private socket uses the same engine store. New unproven resources are
  # retained and prohibit PASS; inventory difference is never ownership proof.
  if [ "${CI_BASELINE_READY:-0}" -eq 1 ] && [ "$directory_trusted" -eq 1 ]; then
    local kind current id base found
    for kind in container network volume; do
      current=$(_ci_inventory "$kind") || { CI_CLEANUP_FAILURE=1; continue; }
      base=$(cat "${CI_BASELINE_FILE}.${kind}") || { CI_CLEANUP_FAILURE=1; continue; }
      for id in $current; do
        found=0
        local prior
        for prior in $base; do
          if [ "$id" = "$prior" ]; then found=1; break; fi
        done
        if [ "$found" -eq 0 ]; then
          echo "ERROR: Unproven new ${kind} resource retained: ${id}" >&2
          CI_CLEANUP_FAILURE=1
        fi
      done
      printf '%s\n' "$current" > "${CI_STATE_FILE}.final-${kind}" || CI_CLEANUP_FAILURE=1
    done
  fi

  if [ -n "$CI_ENDPOINT_PID" ]; then
    if ! _stop_owned_endpoint; then CI_CLEANUP_FAILURE=1; fi
  fi

  if [ "$CI_RUN_DIR_CREATED" -eq 1 ]; then
    identity=$(stat -c '%d:%i:%u' "$CI_RUN_DIR") || CI_CLEANUP_FAILURE=1
    if [ -L "$CI_RUN_DIR" ] || [ "$identity" != "$CI_RUN_DIR_INODE" ]; then
      echo 'ERROR: Cleanup identity mismatch for endpoint directory; retaining it' >&2
      CI_CLEANUP_FAILURE=1
    fi
    # Remove the checked socket only after endpoint termination is proven.
    # Keep directory and inventories as durable failure/deviation evidence.
    if [ "$CI_CLEANUP_FAILURE" -eq 0 ] && [ -n "$CI_SOCKET_IDENTITY" ]; then
      identity=$(stat -c '%d:%i:%u' "$CI_ENDPOINT_SOCK") || CI_CLEANUP_FAILURE=1
      if [ -L "$CI_ENDPOINT_SOCK" ] || [ "$identity" != "$CI_SOCKET_IDENTITY" ]; then
        CI_CLEANUP_FAILURE=1
      elif ! rm -- "$CI_ENDPOINT_SOCK"; then
        CI_CLEANUP_FAILURE=1
      fi
      if [ -e "$CI_ENDPOINT_SOCK" ] || [ -L "$CI_ENDPOINT_SOCK" ]; then CI_CLEANUP_FAILURE=1; fi
    fi
    printf 'endpoint_directory_retained=%s cleanup_failure=%s\n' "$CI_RUN_DIR" "$CI_CLEANUP_FAILURE" \
      >> "${CI_STATE_FILE}.cleanup" || CI_CLEANUP_FAILURE=1
  fi

  # 5. Record final durable state
  if [ "${CI_REUSE_REFUSED:-0}" -eq 0 ] && [ -n "${CI_STATE_FILE:-}" ]; then
    if [ "$CI_FIRST_FAILURE" -eq 0 ] && [ "$CI_CLEANUP_FAILURE" -eq 0 ] && [ "$CI_VERIFIED" -eq 1 ]; then
      _publish_final_receipt "$CI_STATE_FILE" <<EOF || CI_CLEANUP_FAILURE=1
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"passed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}"}
EOF
    fi
    if [ "$CI_FIRST_FAILURE" -ne 0 ] || [ "$CI_CLEANUP_FAILURE" -ne 0 ] || [ "$CI_VERIFIED" -ne 1 ]; then
      local eff_code="$CI_FIRST_FAILURE"
      if [ "$eff_code" -eq 0 ]; then eff_code=1; fi
      _publish_final_receipt "$CI_STATE_FILE" <<EOF || CI_CLEANUP_FAILURE=1
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"failed","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","exit_code":${eff_code},"cleanup_failure":${CI_CLEANUP_FAILURE}}
EOF
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

  [ "$CI_VERIFIED" -eq 1 ] || exit 1
  exit 0
}

_run_integration_ci() {
  echo "=== Running Fixed-Purpose Verification: Mode 'integration-ci' ==="

  _capture_source_identity
  CI_RUN_ID="ci_integ_${GITHUB_RUN_ID:-$$}"
  [[ "$CI_RUN_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || _fail "ERROR: Invalid integration run ID"
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
{"run_id":"${CI_RUN_ID}","mode":"integration-ci","status":"running","baseline_sha":"${APPROVED_BASELINE_SHA}","parent_sha":"${APPROVED_PARENT_SHA}","candidate_sha":"${TESTED_SHA}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
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
  CI_RUN_DIR_INODE=$(stat -c "%d:%i:%u" "$CI_RUN_DIR")

  CI_ENDPOINT_SOCK="${CI_RUN_DIR}/podman.sock"
  CI_BASELINE_FILE="${CI_RUN_DIR}/baseline_containers.txt"
  CI_CURRENT_FILE="${CI_RUN_DIR}/current_containers.txt"
  CI_RUNNER_NAME="s2_integ_runner_${CI_RUN_ID}"

  # Phase 1 & 2: Setup Private Owned Endpoint & Mount Guards
  echo "--- Phase 1 & 2: Private Endpoint Setup & Fail-Closed Mount Guards ---"
  podman system service --time=0 "unix://${CI_ENDPOINT_SOCK}" &
  CI_ENDPOINT_PID=$!
  CI_ENDPOINT_IDENTITY=$(_endpoint_identity "$CI_ENDPOINT_PID")

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
  CI_SOCKET_IDENTITY=$(stat -c '%d:%i:%u' "$CI_ENDPOINT_SOCK")

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
  local image_st=0
  podman image exists s2-assets-dev:ci || image_st=$?
  if [ "$image_st" -gt 1 ]; then _fail "ERROR: Base image inspection failed ($image_st)"; fi
  if [ "$image_st" -eq 1 ]; then
    echo "Building base development tooling image s2-assets-dev:ci..."
    podman build -f "${REPO_ROOT}/deploy/podman/dev.Containerfile" -t s2-assets-dev:ci "${REPO_ROOT}"
  fi
  cat << 'EOF' | podman build -t s2-assets-integration:ci -f - "${REPO_ROOT}"
FROM s2-assets-dev:ci
USER root
RUN apk add --no-cache podman curl bash
RUN printf '#!/bin/sh\nif [ -z "${CONTAINER_HOST:-}" ]; then echo "ERROR: CONTAINER_HOST is required; no fallback permitted" >&2; exit 1; fi\nexec /usr/bin/podman --remote --url "${CONTAINER_HOST}" "$@"\n' > /usr/local/bin/podman && chmod +x /usr/local/bin/podman
EOF

  # Record all relevant resource inventories; any inspection error halts startup.
  local kind runner_exists=0
  for kind in container network volume; do
    _ci_inventory "$kind" > "${CI_BASELINE_FILE}.${kind}"
  done
  CI_BASELINE_READY=1
  podman container exists "$CI_RUNNER_NAME" || runner_exists=$?
  [ "$runner_exists" -eq 1 ] || _fail "ERROR: Runner name occupied or inspection failed"

  # Phase 3: Run integration tests with safe mount contract (NO :z or :Z on socket)
  echo "--- Phase 3: Running Integration Tests via Safe Private Endpoint ---"
  CI_MUTATION_STARTED=1
  podman run --name "$CI_RUNNER_NAME" --cidfile "${CI_RUN_DIR}/runner.cid" \
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

  CI_RUNNER_CID=$(cat "${CI_RUN_DIR}/runner.cid")
  [[ "$CI_RUNNER_CID" =~ ^[a-f0-9]{64}$ ]] || _fail "ERROR: Invalid runner CID"
  local runner_receipt
  runner_receipt=$(_ci_runner_receipt "$CI_RUNNER_CID")
  jq -e '.state | .Running == false and .Status == "exited" and .Pid == 0 and
    .ExitCode == 0 and .OOMKilled == false and .Restarting == false and .Dead == false and .Paused == false'     <<< "$runner_receipt" >/dev/null
  printf '%s\n' "$runner_receipt" > "${CI_STATE_FILE}.terminal"
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
