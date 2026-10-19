#!/usr/bin/env bash
# ==============================================================================
# scripts/restore.sh — Non-interactive PostgreSQL Restore Verification via Rootless Podman
# ==============================================================================
# Usage:
#   [RESTORE_DB_USER=<user>] scripts/restore.sh <container> <target-database> <archive> [<user>]
#
# Arguments:
#   <container>        Running PostgreSQL container name or ID in Rootless Podman.
#                      Must identify the authorized Development PostgreSQL instance:
#                      's2-assets-dev-postgres' in project 's2-assets-dev'.
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
#     instance: 's2-assets-dev-postgres', project 's2-assets-dev'.
#   - Validates actual container and Compose project identity via 'podman inspect',
#     rejecting unverified, foreign, or production instances.
#   - Enforces fail-closed validation on all inputs, rejecting option injection,
#     connection URIs, and ambiguous arguments.
#   - Protects the live development source database ('s2_assets_dev'), production,
#     and system databases against accidental mutation.
#   - Verifies target database ownership and isolation before restore:
#       1. Non-interactive authentication must succeed (-w / --no-password).
#       2. Target database must already exist (does NOT auto-create databases).
#       3. Target database must be owned by the authorized user.
#       4. Target database must be clean (0 pre-existing user tables); does NOT
#          auto-drop or delete existing objects.
#       5. Target database must have no other active connections.
#   - Validates backup archive integrity via format verification and 'pg_restore -l'
#     table-of-contents validation prior to database restoration.
#   - Preserves backup archives as strictly read-only; never removes or mutates them.
#   - Streams archive via standard input using 'podman exec -i <container> pg_restore'
#     without a pseudo-TTY (no -t/--tty), keeping streams clean.
#   - Restores using '--single-transaction' (-1) and '--exit-on-error' (-e) to guarantee
#     that any error halts execution and completely rolls back changes, preventing
#     partial or corrupt restoration state.
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
# 2. Validate Container Identifier
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
# 3. Validate Target Database Name
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
# 6. Validate Container & Development Runtime Instance Identity
# ------------------------------------------------------------------------------
# Inspect container state: must exist and be currently running
if ! IS_RUNNING="$(podman inspect --format '{{.State.Running}}' "${CONTAINER}" 2>/dev/null)"; then
  echo "ERROR: Container '${CONTAINER}' does not exist or cannot be inspected by Podman" >&2
  exit 1
fi

if [ "${IS_RUNNING}" != "true" ]; then
  echo "ERROR: Container '${CONTAINER}' is not currently running (State.Running = ${IS_RUNNING})" >&2
  exit 1
fi

# Inspect container name and Compose labels to verify exact development instance
CONTAINER_NAME="$(podman inspect --format '{{.Name}}' "${CONTAINER}" 2>/dev/null | sed 's|^/||')"
COMPOSE_PROJECT="$(podman inspect --format '{{or (index .Config.Labels "com.docker.compose.project") (index .Config.Labels "io.podman.compose.project")}}' "${CONTAINER}" 2>/dev/null || true)"
COMPOSE_SERVICE="$(podman inspect --format '{{or (index .Config.Labels "com.docker.compose.service") (index .Config.Labels "io.podman.compose.service")}}' "${CONTAINER}" 2>/dev/null || true)"

# Check container name: must be 's2-assets-dev-postgres' or match project/service pattern
if [ "${CONTAINER_NAME}" != "s2-assets-dev-postgres" ] && ! [[ "${CONTAINER_NAME}" =~ ^.*s2-assets-dev.*postgres.*$ ]]; then
  echo "ERROR: Container name '${CONTAINER_NAME}' does not match authorized Development PostgreSQL instance 's2-assets-dev-postgres'." >&2
  exit 1
fi

# Check Compose project: must be 's2-assets-dev'
if [ "${COMPOSE_PROJECT}" != "s2-assets-dev" ]; then
  echo "ERROR: Container '${CONTAINER}' belongs to project '${COMPOSE_PROJECT}', expected authorized development project 's2-assets-dev'." >&2
  exit 1
fi

# Check Compose service: must be 'postgres'
if [ -n "${COMPOSE_SERVICE}" ] && [ "${COMPOSE_SERVICE}" != "postgres" ]; then
  echo "ERROR: Container service is '${COMPOSE_SERVICE}', expected 'postgres'." >&2
  exit 1
fi

# Reject any production indicator on the inspected container
case "${CONTAINER_NAME}" in
  *prod*|*production*)
    echo "ERROR: Container '${CONTAINER_NAME}' indicates a production environment. Restore is restricted to development runtime." >&2
    exit 1
    ;;
esac

# ------------------------------------------------------------------------------
# 7. Verify Target Database Ownership and Isolation
# ------------------------------------------------------------------------------
# 7.1. Non-interactive connectivity and authentication preflight
if ! podman exec "${CONTAINER}" pg_isready -U "${DB_USER}" -d "${TARGET_DB}" >/dev/null 2>&1; then
  echo "ERROR: Non-interactive authentication or connectivity preflight failed for user '${DB_USER}' on database '${TARGET_DB}' in container '${CONTAINER}'." >&2
  exit 1
fi

# 7.2. Verify target database existence and verifiable ownership
# Connects directly to target database with -w (never prompts for password)
DB_OWNER="$(podman exec "${CONTAINER}" psql -U "${DB_USER}" -w -d "${TARGET_DB}" -t -A -c "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database();" 2>/dev/null || true)"

if [ -z "${DB_OWNER}" ]; then
  echo "ERROR: Unable to verify ownership for target database '${TARGET_DB}'. Database must already exist and be accessible non-interactively. Automatic database creation is prohibited." >&2
  exit 1
fi

if [ "${DB_OWNER}" != "${DB_USER}" ]; then
  echo "ERROR: Target database '${TARGET_DB}' owner is '${DB_OWNER}', expected authorized user '${DB_USER}'. Verifiable database ownership failed." >&2
  exit 1
fi

# 7.3. Verify destination isolation: target database must be clean (0 pre-existing user tables)
# Script is strictly forbidden from dropping tables or databases automatically
EXISTING_TABLES="$(podman exec "${CONTAINER}" psql -U "${DB_USER}" -w -d "${TARGET_DB}" -t -A -c "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');" 2>/dev/null || true)"

if [ -z "${EXISTING_TABLES}" ]; then
  echo "ERROR: Failed to query existing table count in target database '${TARGET_DB}'" >&2
  exit 1
fi

if [ "${EXISTING_TABLES}" -ne 0 ]; then
  echo "ERROR: Target database '${TARGET_DB}' is not empty (${EXISTING_TABLES} existing user tables found). Target destination must be an isolated, clean test database. Automatic dropping of database objects or databases is prohibited." >&2
  exit 1
fi

# 7.4. Verify destination isolation: no competing active client connections
ACTIVE_CONNECTIONS="$(podman exec "${CONTAINER}" psql -U "${DB_USER}" -w -d "${TARGET_DB}" -t -A -c "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();" 2>/dev/null || true)"

if [ -n "${ACTIVE_CONNECTIONS}" ] && [ "${ACTIVE_CONNECTIONS}" -ne 0 ]; then
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
# 9. Non-interactive Logical Restore via Rootless Podman
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
# 10. Post-Restore Verification
# ------------------------------------------------------------------------------
RESTORED_TABLES="$(podman exec "${CONTAINER}" psql -U "${DB_USER}" -w -d "${TARGET_DB}" -t -A -c "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');" 2>/dev/null || true)"

if [ -z "${RESTORED_TABLES}" ] || [ "${RESTORED_TABLES}" -eq 0 ]; then
  echo "ERROR: Post-restore verification failed: target database '${TARGET_DB}' contains no user tables after restore" >&2
  exit 1
fi

echo "PostgreSQL logical restore completed and verified successfully: ${RESTORED_TABLES} table(s) restored into isolated test database '${TARGET_DB}'"
exit 0
