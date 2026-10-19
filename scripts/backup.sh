#!/usr/bin/env bash
# ==============================================================================
# scripts/backup.sh — Non-interactive PostgreSQL Logical Backup via Rootless Podman
# ==============================================================================
# Usage:
#   scripts/backup.sh <container> <database> <destination>
#
# Arguments:
#   <container>    Running PostgreSQL container name or ID in Rootless Podman.
#                  Must be alphanumeric with optional '_', '.', or '-'.
#                  Must not start with '-'.
#   <database>     PostgreSQL database name to dump.
#                  Must be a valid identifier (alphanumeric, '_', '-').
#                  Must not start with '-', contain connection URIs, key=val pairs,
#                  or unintended option/connection-string components.
#   <destination>  Target file path for the completed backup archive.
#                  Must resolve to a physical location strictly outside the
#                  repository tree (including symlinks and traversal cases).
#                  Parent directory must exist and be writable.
#                  Target file must not already exist.
#
# Options:
#   -h, --help     Display this usage information and exit.
#
# Assumptions:
#   - Rootless Podman is installed and available in PATH.
#   - The target PostgreSQL container is running and contains pg_dump.
#   - No host-installed PostgreSQL client tools (pg_dump, psql) are required.
#   - Non-interactive execution is enforced (-w / --no-password); execution
#     fails immediately if credentials/authentication cannot proceed without prompting.
#   - Diagnostic messages from pg_dump/podman are emitted to stderr, keeping
#     the stdout archive stream uncorrupted.
#   - Incomplete backups are cleaned up automatically upon command failure or
#     interruption; pre-existing backups are never removed or overwritten.
#   - Backup archive is created and published with mode 0600 (private to owner).
# ==============================================================================

set -euo pipefail
umask 077

usage() {
  cat << 'EOF'
Usage: scripts/backup.sh <container> <database> <destination>

Perform a non-interactive PostgreSQL logical backup from a Rootless Podman container.

Arguments:
  <container>    Running PostgreSQL container name or ID
  <database>     PostgreSQL database name to dump
  <destination>  Target backup file path (must resolve outside repository)

Options:
  -h, --help     Show this help message and exit
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ $# -ne 3 ]; then
  echo "ERROR: Exactly 3 arguments required (<container> <database> <destination>), but got $#" >&2
  usage >&2
  exit 1
fi

CONTAINER="$1"
DATABASE="$2"
DESTINATION="$3"

# ------------------------------------------------------------------------------
# 1. Validate Container Identifier
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

# ------------------------------------------------------------------------------
# 2. Validate Database Name
# ------------------------------------------------------------------------------
if [ -z "${DATABASE}" ]; then
  echo "ERROR: Database name cannot be empty" >&2
  exit 1
fi

if [[ "${DATABASE}" == -* ]]; then
  echo "ERROR: Database name cannot start with '-': ${DATABASE}" >&2
  exit 1
fi

# Reject connection strings, URIs, key=value conninfo, spaces, or option flags
if ! [[ "${DATABASE}" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]]; then
  echo "ERROR: Invalid database name: '${DATABASE}'. Must be a valid identifier and not an option or connection string." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 3. Validate Destination File and Path Boundary
# ------------------------------------------------------------------------------
if [ -z "${DESTINATION}" ]; then
  echo "ERROR: Destination path cannot be empty" >&2
  exit 1
fi

if [[ "${DESTINATION}" == -* ]]; then
  echo "ERROR: Destination path cannot start with '-': ${DESTINATION}" >&2
  exit 1
fi

if [[ "${DESTINATION}" == */ ]]; then
  echo "ERROR: Destination path cannot end with a trailing slash (must be a file path): ${DESTINATION}" >&2
  exit 1
fi

if [ -d "${DESTINATION}" ]; then
  echo "ERROR: Destination is an existing directory, expected a file path: ${DESTINATION}" >&2
  exit 1
fi

if [ -e "${DESTINATION}" ] || [ -L "${DESTINATION}" ]; then
  echo "ERROR: Destination file already exists: ${DESTINATION}" >&2
  exit 1
fi

DEST_DIR="$(dirname "${DESTINATION}")"
if [ ! -d "${DEST_DIR}" ]; then
  echo "ERROR: Destination directory does not exist: ${DEST_DIR}" >&2
  exit 1
fi

REAL_DEST_DIR="$(cd "${DEST_DIR}" 2>/dev/null && pwd -P)"
if [ -z "${REAL_DEST_DIR}" ]; then
  echo "ERROR: Unable to resolve physical directory for destination: ${DEST_DIR}" >&2
  exit 1
fi

if [ ! -w "${REAL_DEST_DIR}" ]; then
  echo "ERROR: Destination directory is not writable: ${REAL_DEST_DIR}" >&2
  exit 1
fi

DEST_BASE="$(basename "${DESTINATION}")"
if [ "${DEST_BASE}" = "." ] || [ "${DEST_BASE}" = ".." ]; then
  echo "ERROR: Invalid destination filename: ${DEST_BASE}" >&2
  exit 1
fi

REAL_DEST="${REAL_DEST_DIR}/${DEST_BASE}"
if [ -e "${REAL_DEST}" ] || [ -L "${REAL_DEST}" ]; then
  echo "ERROR: Resolved destination file already exists: ${REAL_DEST}" >&2
  exit 1
fi

# Determine physical repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." 2>/dev/null && pwd -P)"

if [ -z "${REPO_ROOT}" ]; then
  echo "ERROR: Unable to resolve repository root directory" >&2
  exit 1
fi

# Ensure destination directory and file resolve strictly outside the repository
if [ "${REAL_DEST_DIR}" = "${REPO_ROOT}" ] || [[ "${REAL_DEST_DIR}" == "${REPO_ROOT}/"* ]] || \
   [ "${REAL_DEST}" = "${REPO_ROOT}" ] || [[ "${REAL_DEST}" == "${REPO_ROOT}/"* ]]; then
  echo "ERROR: Resolved destination is inside the repository: ${REAL_DEST}. Backups must be saved outside the repository." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 4. Prerequisites Check
# ------------------------------------------------------------------------------
if ! command -v podman >/dev/null 2>&1; then
  echo "ERROR: podman is not installed or not in PATH" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 5. Temporary File and Cleanup Trap
# ------------------------------------------------------------------------------
TEMP_FILE=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  if [ -n "${TEMP_FILE:-}" ] && [ -f "${TEMP_FILE}" ]; then
    rm -f "${TEMP_FILE}"
  fi
  if [ "${exit_code}" -eq 0 ]; then
    exit 1
  fi
  exit "${exit_code}"
}

trap cleanup EXIT INT TERM HUP

TEMP_FILE="$(mktemp "${REAL_DEST_DIR}/.backup_${DEST_BASE}.XXXXXX")"
chmod 0600 "${TEMP_FILE}"

# ------------------------------------------------------------------------------
# 6. Non-interactive Logical Dump via Rootless Podman
# ------------------------------------------------------------------------------
# Executes without pseudo-TTY (no -t/--tty) so stdout remains a clean binary stream.
# -F c: Custom-format archive suitable for pg_restore.
# -w: Never issue a password prompt; fail closed if authentication is required.
# Stderr is not redirected, keeping diagnostic output separate from the archive.
if ! podman exec "${CONTAINER}" pg_dump -F c -w -d "${DATABASE}" > "${TEMP_FILE}"; then
  echo "ERROR: PostgreSQL logical backup failed for database '${DATABASE}' in container '${CONTAINER}'" >&2
  exit 1
fi

if [ ! -s "${TEMP_FILE}" ]; then
  echo "ERROR: PostgreSQL backup produced an empty archive" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 7. Atomic Publication Without Overwrite
# ------------------------------------------------------------------------------
if [ -e "${REAL_DEST}" ] || [ -L "${REAL_DEST}" ]; then
  echo "ERROR: Destination file collision: '${REAL_DEST}' already exists" >&2
  exit 1
fi

if ln "${TEMP_FILE}" "${REAL_DEST}" 2>/dev/null; then
  rm -f "${TEMP_FILE}"
  TEMP_FILE=""
elif mv -n "${TEMP_FILE}" "${REAL_DEST}" && [ ! -f "${TEMP_FILE}" ]; then
  TEMP_FILE=""
else
  echo "ERROR: Failed to publish backup to '${REAL_DEST}' without overwriting" >&2
  exit 1
fi

chmod 0600 "${REAL_DEST}"

# Disarm trap before successful termination
trap - EXIT INT TERM HUP

echo "PostgreSQL logical backup completed successfully: ${REAL_DEST}"
exit 0
