#!/usr/bin/env bash
# ==============================================================================
# scripts/restore.sh — Non-interactive PostgreSQL Restore Verification via Rootless Podman
# ==============================================================================
# Usage:
#   [RESTORE_DB_USER=<user>] scripts/restore.sh <container> <target-database> <archive> [<user>]
#
# Arguments:
#   <container>        Running PostgreSQL container name or ID in Rootless Podman.
#                      Must strictly identify the authorized Development PostgreSQL instance:
#                      exactly named 's2-assets-dev-postgres' in project 's2-assets-dev'
#                      with Compose service 'postgres'.
#                      Must be alphanumeric with optional '_', '.', or '-'.
#                      Must not start with '-'.
#   <target-database>  Isolated target PostgreSQL test database name.
#                      Must be a valid identifier (alphanumeric, '_', '-').
#                      Must not start with '-', contain connection URIs, key=val pairs,
#                      or unintended option/connection-string components.
#                      Must strictly NOT be the source development database ('s2_assets_dev'),
#                      production database, or any system database ('postgres', 'template*').
#                      Must be explicitly designated as an isolated test/restore database
#                      (e.g., matching '*test*' or '*restore*').
#   <archive>          Path to the logical backup archive to restore.
#                      Must exist as a regular, readable, non-empty file.
#                      Must be a valid PostgreSQL custom-format archive (magic 'PGDMP').
#                      Must NOT be overwritten, modified, or deleted.
#   [<user>]           Optional 4th argument for explicit PostgreSQL user/role name.
#                      If omitted, must be supplied via RESTORE_DB_USER (or PGUSER).
#                      Must be a valid identifier (alphanumeric, '_', '-') and not
#                      start with '-'.
#
# Environment:
#   RESTORE_DB_USER    Explicit PostgreSQL user/role name for authentication
#                      (required if 4th argument is not provided; alternatively accepts PGUSER).
#                      Must be a valid identifier (alphanumeric, '_', '-') and not
#                      start with '-'.
#
# Options:
#   -h, --help         Display this usage information and exit.
#
# Safety & Verification Contract:
#   - Restricts execution strictly to the existing Rootless Podman Development
#     instance: exactly named 's2-assets-dev-postgres', project 's2-assets-dev',
#     service 'postgres'. Rejects foreign, lookalike, or production containers.
#   - Re-confirms container identity and target safety immediately before any write.
#   - Enforces fail-closed validation on all inputs, rejecting option injection,
#     connection URIs, and ambiguous arguments.
#   - Protects the live development source database ('s2_assets_dev'), production,
#     and system databases against accidental mutation.
#   - Verifies target database ownership and isolation before restore:
#       1. PostgreSQL server readiness preflight via pg_isready.
#       2. Non-interactive authentication and credentials verified fail-closed via psql (-w).
#       3. Target database must already exist (does NOT auto-create databases).
#       4. Target database must be owned by the authorized user.
#       5. Target database must be completely clean (0 user-defined relations,
#          views, sequences, routines, types, or custom schemas); does NOT auto-drop
#          or delete existing objects.
#       6. Target database must have no other active connections.
#   - Validates backup archive integrity via format verification and 'pg_restore -l'
#     table-of-contents validation prior to database restoration.
#   - Preserves backup archives as strictly read-only; never removes or mutates them.
#   - Streams archive via standard input using 'podman exec -i <container> pg_restore'
#     without a pseudo-TTY (no -t/--tty), keeping streams clean.
#   - Restores using '--single-transaction' (-1) and '--exit-on-error' (-e) to guarantee
#     that any error halts execution and completely rolls back changes, preventing
#     partial or corrupt restoration state.
#   - Fails closed on any query error, empty count, or non-numeric output without masking.
#   - Never masks errors; non-zero exit codes are propagated immediately.
# ==============================================================================

set -euo pipefail

usage() {
  cat << 'EOF'
Usage: [RESTORE_DB_USER=<user>] scripts/restore.sh <container> <target-database> <archive> [<user>]

Perform a non-interactive PostgreSQL logical restore into an isolated test database
within the existing Rootless Podman Development instance.

Arguments:
  <container>        Running PostgreSQL container name or ID (must be 's2-assets-dev-postgres')
  <target-database>  Isolated target test database name (e.g. '*test*' or '*restore*')
  <archive>          Path to backup archive (PostgreSQL custom format)
  [<user>]           PostgreSQL user for authentication (or set RESTORE_DB_USER / PGUSER)

Environment:
  RESTORE_DB_USER    PostgreSQL user for authentication (or PGUSER; required if [<user>] omitted)

Options:
  -h, --help         Show this help message and exit
EOF
}

# ------------------------------------------------------------------------------
# Helper Functions: Fail-Closed Query Execution and Numeric Validation
# ------------------------------------------------------------------------------

# Execute a verification query via psql in the container with strict fail-closed error propagation.
# Does NOT mask errors. Runs with -X (no .psqlrc), -v ON_ERROR_STOP=1, -w (never prompt), -t -A.
exec_psql_query() {
  local container="$1"
  local user="$2"
  local db="$3"
  local sql="$4"
  local description="$5"

  local query_output=""
  local query_status=0

  query_output="$(podman exec "${container}" psql -X -v ON_ERROR_STOP=1 -U "${user}" -w -d "${db}" -t -A -c "${sql}" 2>&1)" || query_status=$?

  if [ "${query_status}" -ne 0 ]; then
    echo "ERROR: Database query failed during ${description} (exit code ${query_status}): ${query_output}" >&2
    exit 1
  fi

  printf '%s\n' "${query_output}"
}

# Assert that a query result is a valid non-negative integer. Rejects empty, whitespace, or non-numeric text.
assert_valid_count() {
  local value="$1"
  local description="$2"

  if [ -z "${value}" ]; then
    echo "ERROR: Query for ${description} returned empty output, expected a non-negative integer" >&2
    exit 1
  fi

  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Query for ${description} returned non-numeric output: '${value}'" >&2
    exit 1
  fi
}

# Validate container running state, exact name, and positive Compose labels
verify_development_container_identity() {
  local container="$1"
  local stage_desc="$2"

  local is_running=""
  local container_name=""
  local compose_project=""
  local compose_service=""

  # 1. Inspect container state: must exist and be currently running
  if ! is_running="$(podman inspect --format '{{.State.Running}}' "${container}" 2>/dev/null)"; then
    echo "ERROR: Container '${container}' does not exist or cannot be inspected by Podman (${stage_desc})" >&2
    exit 1
  fi

  if [ "${is_running}" != "true" ]; then
    echo "ERROR: Container '${container}' is not currently running (State.Running = ${is_running}) (${stage_desc})" >&2
    exit 1
  fi

  # 2. Inspect exact container name (strip leading slash)
  container_name="$(podman inspect --format '{{.Name}}' "${container}" 2>/dev/null | sed 's|^/||')"

  # Enforce exact match: must be exactly 's2-assets-dev-postgres' (reject lookalikes)
  if [ "${container_name}" != "s2-assets-dev-postgres" ]; then
    echo "ERROR: Container name '${container_name}' does not match authorized Development PostgreSQL instance: expected exactly 's2-assets-dev-postgres' (${stage_desc})" >&2
    exit 1
  fi

  # 3. Inspect Compose project label: must be exactly 's2-assets-dev'
  compose_project="$(podman inspect --format '{{or (index .Config.Labels "com.docker.compose.project") (index .Config.Labels "io.podman.compose.project")}}' "${container}" 2>/dev/null || true)"

  if [ "${compose_project}" != "s2-assets-dev" ]; then
    echo "ERROR: Container '${container}' Compose project is '${compose_project}', expected exactly 's2-assets-dev' (${stage_desc})" >&2
    exit 1
  fi

  # 4. Inspect Compose service label: must be positively present and exactly 'postgres'
  compose_service="$(podman inspect --format '{{or (index .Config.Labels "com.docker.compose.service") (index .Config.Labels "io.podman.compose.service")}}' "${container}" 2>/dev/null || true)"

  if [ -z "${compose_service}" ]; then
    echo "ERROR: Container '${container}' is missing required Compose service label (${stage_desc})" >&2
    exit 1
  fi

  if [ "${compose_service}" != "postgres" ]; then
    echo "ERROR: Container '${container}' Compose service is '${compose_service}', expected exactly 'postgres' (${stage_desc})" >&2
    exit 1
  fi

  # 5. Reject any production indicator on the inspected container
  case "${container_name}" in
    *prod*|*production*)
      echo "ERROR: Container '${container_name}' indicates a production environment. Restore is restricted to development runtime (${stage_desc})." >&2
      exit 1
      ;;
  esac
}

# ------------------------------------------------------------------------------
# Argument Handling & Help Option
# ------------------------------------------------------------------------------
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "ERROR: Invalid number of arguments. Expected 3 or 4 (<container> <target-database> <archive> [<user>]), but got $#" >&2
  usage >&2
  exit 1
fi

CONTAINER="$1"
TARGET_DB="$2"
ARCHIVE="$3"

# ------------------------------------------------------------------------------
# 1. Validate Database User (from 4th argument or RESTORE_DB_USER / PGUSER)
# ------------------------------------------------------------------------------
ARG_USER="${4:-}"
ENV_USER="${RESTORE_DB_USER:-${PGUSER:-}}"

if [ -n "${ARG_USER}" ] && [ -n "${ENV_USER}" ] && [ "${ARG_USER}" != "${ENV_USER}" ]; then
  echo "ERROR: Ambiguous PostgreSQL user specified: argument is '${ARG_USER}' but environment variable is '${ENV_USER}'. Rejecting ambiguous inputs." >&2
  exit 1
fi

DB_USER="${ARG_USER:-${ENV_USER}}"

if [ -z "${DB_USER}" ]; then
  echo "ERROR: PostgreSQL user is required. Supply as 4th argument or set RESTORE_DB_USER (or PGUSER) in the environment." >&2
  exit 1
fi

if [[ "${DB_USER}" == -* ]]; then
  echo "ERROR: PostgreSQL user cannot start with '-': ${DB_USER}" >&2
  exit 1
fi

# Reject option flags, URIs, key=val conninfo, spaces, or control characters
if ! [[ "${DB_USER}" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]]; then
  echo "ERROR: Invalid database user name: '${DB_USER}'. Must be a valid identifier and not an option or connection string." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 2. Validate Container Identifier Argument
# ------------------------------------------------------------------------------
if [ -z "${CONTAINER}" ]; then
  echo "ERROR: Container identifier cannot be empty" >&2
  exit 1
fi

if [[ "${CONTAINER}" == -* ]]; then
  echo "ERROR: Container identifier cannot start with '-': ${CONTAINER}" >&2
  exit 1
fi

if ! [[ "${CONTAINER}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "ERROR: Invalid container identifier: '${CONTAINER}'. Must be alphanumeric and may include '_', '.', or '-'." >&2
  exit 1
fi

# Explicitly reject production indicators in container argument
case "${CONTAINER}" in
  *prod*|*production*)
    echo "ERROR: Container identifier '${CONTAINER}' indicates production. Production targets are strictly prohibited." >&2
    exit 1
    ;;
esac

# ------------------------------------------------------------------------------
# 3. Validate Target Database Name Argument
# ------------------------------------------------------------------------------
if [ -z "${TARGET_DB}" ]; then
  echo "ERROR: Target database name cannot be empty" >&2
  exit 1
fi

if [[ "${TARGET_DB}" == -* ]]; then
  echo "ERROR: Target database name cannot start with '-': ${TARGET_DB}" >&2
  exit 1
fi

# Reject connection strings, URIs, key=value conninfo, spaces, or option flags
if ! [[ "${TARGET_DB}" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]]; then
  echo "ERROR: Invalid target database name: '${TARGET_DB}'. Must be a valid identifier and not an option or connection string." >&2
  exit 1
fi

# Reject source development database: strictly read-only, never restore into it
if [ "${TARGET_DB}" = "s2_assets_dev" ]; then
  echo "ERROR: Cannot restore into source development database 's2_assets_dev'. Restore is strictly restricted to an isolated test database." >&2
  exit 1
fi

# Reject repository default database and production databases
case "${TARGET_DB}" in
  s2_assets|*prod*|*production*)
    echo "ERROR: Target database '${TARGET_DB}' indicates a production or default database. Prohibited target." >&2
    exit 1
    ;;
esac

# Reject PostgreSQL system and template databases
case "${TARGET_DB}" in
  postgres|template0|template1|template*|default)
    echo "ERROR: Target database '${TARGET_DB}' is a system database. Prohibited target." >&2
    exit 1
    ;;
esac

# Enforce that the target database is explicitly designated as an isolated test destination
if ! [[ "${TARGET_DB}" =~ (test|restore) ]] && ! [[ "${TARGET_DB}" =~ ^s2_foundation_ ]]; then
  echo "ERROR: Target database '${TARGET_DB}' must be explicitly designated as an isolated test destination (name must contain 'test', 'restore', or start with 's2_foundation_')." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 4. Validate Backup Archive File
# ------------------------------------------------------------------------------
if [ -z "${ARCHIVE}" ]; then
  echo "ERROR: Archive path cannot be empty" >&2
  exit 1
fi

if [[ "${ARCHIVE}" == -* ]]; then
  echo "ERROR: Archive path cannot start with '-': ${ARCHIVE}" >&2
  exit 1
fi

if [[ "${ARCHIVE}" == */ ]]; then
  echo "ERROR: Archive path cannot end with a trailing slash (must be a file path): ${ARCHIVE}" >&2
  exit 1
fi

if [ -d "${ARCHIVE}" ]; then
  echo "ERROR: Archive path is a directory, expected a file path: ${ARCHIVE}" >&2
  exit 1
fi

if [ ! -e "${ARCHIVE}" ]; then
  echo "ERROR: Backup archive file does not exist: ${ARCHIVE}" >&2
  exit 1
fi

if [ ! -f "${ARCHIVE}" ]; then
  echo "ERROR: Backup archive is not a regular file: ${ARCHIVE}" >&2
  exit 1
fi

if [ ! -r "${ARCHIVE}" ]; then
  echo "ERROR: Backup archive file is not readable (check permissions): ${ARCHIVE}" >&2
  exit 1
fi

if [ ! -s "${ARCHIVE}" ]; then
  echo "ERROR: Backup archive file is empty: ${ARCHIVE}" >&2
  exit 1
fi

# Resolve physical archive path to verify accessibility
if ! REAL_ARCHIVE="$(realpath -e "${ARCHIVE}" 2>/dev/null)"; then
  echo "ERROR: Unable to resolve physical location of archive file: ${ARCHIVE}" >&2
  exit 1
fi
ARCHIVE="${REAL_ARCHIVE}"

# Validate PostgreSQL custom-format magic bytes ('PGDMP')
ARCHIVE_MAGIC="$(head -c 5 "${ARCHIVE}" 2>/dev/null || true)"
if [ "${ARCHIVE_MAGIC}" != "PGDMP" ]; then
  echo "ERROR: Archive '${ARCHIVE}' is not a valid PostgreSQL custom-format dump (expected 'PGDMP' header, got '${ARCHIVE_MAGIC}')." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 5. Prerequisites Check
# ------------------------------------------------------------------------------
if ! command -v podman >/dev/null 2>&1; then
  echo "ERROR: podman is not installed or not in PATH" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 6. Validate Container & Development Runtime Instance Identity (Preflight)
# ------------------------------------------------------------------------------
verify_development_container_identity "${CONTAINER}" "preflight validation"

# ------------------------------------------------------------------------------
# 7. Verify Target Database Ownership and Isolation
# ------------------------------------------------------------------------------
# 7.1. PostgreSQL server readiness preflight
# Note: pg_isready verifies PostgreSQL server connection status. Credentials and
# non-interactive authentication are authoritatively verified by the subsequent psql queries with -w.
if ! podman exec "${CONTAINER}" pg_isready -d "${TARGET_DB}" >/dev/null 2>&1; then
  echo "ERROR: PostgreSQL service readiness preflight failed for database '${TARGET_DB}' in container '${CONTAINER}'." >&2
  exit 1
fi

# 7.2. Verify target database existence and verifiable ownership fail-closed
# Connects directly to target database with -w; fails closed on authentication failure or if database does not exist
DB_OWNER="$(exec_psql_query "${CONTAINER}" "${DB_USER}" "${TARGET_DB}" "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database();" "database ownership check")"

if [ -z "${DB_OWNER}" ]; then
  echo "ERROR: Unable to verify ownership for target database '${TARGET_DB}'. Database must already exist and be accessible non-interactively. Automatic database creation is prohibited." >&2
  exit 1
fi

if [ "${DB_OWNER}" != "${DB_USER}" ]; then
  echo "ERROR: Target database '${TARGET_DB}' owner is '${DB_OWNER}', expected authorized user '${DB_USER}'. Verifiable database ownership failed." >&2
  exit 1
fi

# 7.3. Verify destination isolation: target database must be completely clean
# Checks for all user-defined objects: relations (tables, views, materialized views, sequences,
# foreign tables, partitioned tables), routines (functions, procedures), user types (enums, composite,
# domains), and non-system custom schemas.
# Automatic dropping of database objects or databases is strictly prohibited.
OBJECT_COUNT_SQL="SELECT (
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p'))
  +
  (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast'))
  +
  (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND t.typtype IN ('e', 'c', 'd'))
  +
  (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public'))
);"

EXISTING_OBJECTS="$(exec_psql_query "${CONTAINER}" "${DB_USER}" "${TARGET_DB}" "${OBJECT_COUNT_SQL}" "target database cleanliness check")"
assert_valid_count "${EXISTING_OBJECTS}" "target database object count"

if [ "${EXISTING_OBJECTS}" -ne 0 ]; then
  echo "ERROR: Target database '${TARGET_DB}' is not empty (${EXISTING_OBJECTS} user-defined object(s) found). Target destination must be an isolated, clean test database. Automatic dropping of database objects or databases is prohibited." >&2
  exit 1
fi

# 7.4. Verify destination isolation: no competing active client connections
ACTIVE_CONNECTIONS="$(exec_psql_query "${CONTAINER}" "${DB_USER}" "${TARGET_DB}" "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();" "active connection check")"
assert_valid_count "${ACTIVE_CONNECTIONS}" "active connection count"

if [ "${ACTIVE_CONNECTIONS}" -ne 0 ]; then
  echo "ERROR: Target database '${TARGET_DB}' has ${ACTIVE_CONNECTIONS} other active connection(s). Isolation cannot be guaranteed." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 8. Archive TOC Validation (Offline / Pre-Restore Integrity Check)
# ------------------------------------------------------------------------------
# Validate archive TOC entries via pg_restore -l on standard input without pseudo-TTY
if ! podman exec -i "${CONTAINER}" pg_restore -l < "${ARCHIVE}" >/dev/null 2>&1; then
  echo "ERROR: Backup archive '${ARCHIVE}' failed TOC inspection with pg_restore -l. Archive may be corrupted or unreadable." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 9. Immediate Pre-Write Confirmation: Re-verify Container Identity and Target Safety
# ------------------------------------------------------------------------------
# Confirms target container and database identity immediately before initiating any write operation
verify_development_container_identity "${CONTAINER}" "immediate pre-write confirmation"

if [ "${TARGET_DB}" = "s2_assets_dev" ]; then
  echo "ERROR: Immediate pre-write guard aborted: target database is source development database 's2_assets_dev'." >&2
  exit 1
fi

case "${TARGET_DB}" in
  s2_assets|*prod*|*production*|postgres|template0|template1|template*|default)
    echo "ERROR: Immediate pre-write guard aborted: prohibited target database '${TARGET_DB}'." >&2
    exit 1
    ;;
esac

# ------------------------------------------------------------------------------
# 10. Non-interactive Logical Restore via Rootless Podman
# ------------------------------------------------------------------------------
# Executes without pseudo-TTY (no -t/--tty); archive is streamed cleanly via stdin (-i).
# -U: Explicit PostgreSQL user for authentication.
# -d: Target database name.
# -w: Never issue a password prompt; fail closed if authentication requires interaction.
# -e: Exit immediately on error (fail-closed, never mask errors).
# --single-transaction (-1): Entire restore is wrapped in a single transaction;
#                           any failure rolls back all changes, preventing partial restore.
# Stderr is preserved for error propagation; backup archive is opened read-only and preserved.
if ! podman exec -i "${CONTAINER}" pg_restore -U "${DB_USER}" -d "${TARGET_DB}" -w -e --single-transaction < "${ARCHIVE}"; then
  echo "ERROR: PostgreSQL logical restore failed for database '${TARGET_DB}' in container '${CONTAINER}'" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 11. Post-Restore Verification
# ------------------------------------------------------------------------------
RESTORED_CHECK_SQL="SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p');"
RESTORED_OBJECTS="$(exec_psql_query "${CONTAINER}" "${DB_USER}" "${TARGET_DB}" "${RESTORED_CHECK_SQL}" "post-restore object check")"
assert_valid_count "${RESTORED_OBJECTS}" "restored object count"

if [ "${RESTORED_OBJECTS}" -eq 0 ]; then
  echo "ERROR: Post-restore verification failed: target database '${TARGET_DB}' contains 0 user objects after restore" >&2
  exit 1
fi

echo "PostgreSQL logical restore completed and verified successfully: ${RESTORED_OBJECTS} object(s) restored into isolated test database '${TARGET_DB}'"
exit 0
