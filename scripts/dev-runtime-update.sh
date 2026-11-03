#!/usr/bin/env bash
# s2-assets development runtime — UPDATE: promote another commit to the installed runtime.
# Backs up the database first (scripts/backup.sh), stops the API and Web, moves the runtime
# checkout to the commit, then hands over to THAT commit's installer, which rebuilds the
# tooling image and reinstalls dependencies only when their inputs changed, refreshes changed
# units, applies pending migrations, starts the API and Web and runs verify.
#   scripts/dev-runtime-update.sh --sha <commit> [--no-backup]
# The commit may be abbreviated (7 or more hex digits); it is resolved after the fetch. The
# runtime checkout fetches from the workspace repository, so a commit made on GitHub, such as
# a pull request's merge, is fetched into a workspace branch first:
#   git fetch origin <branch>:<branch>
# Migrations only move forward: rolling back after a new migration ran means restoring the
# backup taken here (docs/operations/development-runtime.md).
set -Eeuo pipefail
set +a
umask 077
# shellcheck source=scripts/dev-runtime-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/dev-runtime-common.sh"
trap '[[ $BASH_SUBSHELL == 0 ]] && die "unexpected failure (line $LINENO): $BASH_COMMAND"' ERR

SHA='' BACKUP=yes
USAGE="usage: ${0##*/} --sha <commit> [--no-backup]"
while (( $# )); do
  case $1 in
    --sha) (( $# >= 2 )) || die "$USAGE"; SHA=$2; shift 2 ;;
    --no-backup) BACKUP=no; shift ;;
    *) die "$USAGE" ;;
  esac
done
[[ $SHA =~ ^[0-9a-f]{7,40}$ ]] || die "--sha must name a commit: 7 to 40 hex digits"
[[ $(id -u) == 1000 ]] || die "the development runtime belongs to UID 1000"
[[ -d $SRC/.git && -f $UNIT_DIR/s2-assets-dev-api.container ]] \
  || die "the runtime is not installed: use scripts/dev-runtime-install.sh --sha <commit>"
[[ -z $(git -C "$SRC" status --porcelain --untracked-files=no) ]] \
  || die "$SRC has modified tracked files: make changes in your workspace and commit them instead"
git -C "$SRC" fetch --quiet origin
full=$(git -C "$SRC" rev-parse --verify --quiet "$SHA^{commit}") \
  || die "commit $SHA is not on a branch of the workspace repository, or names more than one commit:
commit it in the workspace first, fetch a commit made on GitHub into a workspace branch
(git fetch origin <branch>:<branch>), or give more digits"
SHA=$full
require_sha "$SHA"
git -C "$SRC" cat-file -e "$SHA:scripts/dev-runtime-install.sh" 2>/dev/null \
  || die "commit $SHA predates this development runtime (no scripts/dev-runtime-install.sh)"

if [[ $BACKUP == yes ]]; then
  systemctl --user is-active --quiet "$DB" \
    || die "the database is not running, so it cannot be backed up: start $DB, or pass --no-backup"
  install -d -m 0700 -- "$STATE_DIR/backups"
  dest=$STATE_DIR/backups/$DB_NAME-$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$SRC" rev-parse --short HEAD).dump
  BACKUP_DB_USER=$DB_NAME "$SRC/scripts/backup.sh" "$DB_CTR" "$DB_NAME" "$dest" \
    || die "backup failed: nothing was changed"
  note "database backup written to $dest"
fi
note "stopping $WEB and $API"
systemctl --user stop "$WEB" "$API"
git -C "$SRC" checkout --quiet --detach "$SHA"
printf '%s\n' "$SHA" > "$SRC/$MARKER.tmp"
mv -f -- "$SRC/$MARKER.tmp" "$SRC/$MARKER"
note "runtime checkout moved to $SHA; continuing with that commit's installer"
exec "$SRC/scripts/dev-runtime-install.sh" --sha "$SHA"
