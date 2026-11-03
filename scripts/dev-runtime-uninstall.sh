#!/usr/bin/env bash
# s2-assets development runtime — UNINSTALL.
#   scripts/dev-runtime-uninstall.sh          stop the runtime and remove its units; keep the
#                                             database volume, secrets, tooling image, backups
#                                             and checkout
#   scripts/dev-runtime-uninstall.sh --purge  ALSO delete the database volume, secrets, network
#                                             and tooling image (typed confirmation)
# Only the exact s2-assets-qdev names below are touched. The source checkout and the backups
# under ~/.local/state/s2-assets-qdev/backups are never deleted.
set -Eeuo pipefail
set +a
umask 077
# shellcheck source=scripts/dev-runtime-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/dev-runtime-common.sh"
trap '[[ $BASH_SUBSHELL == 0 ]] && die "unexpected failure (line $LINENO): $BASH_COMMAND"' ERR

PURGE=no
case ${1:-} in
  "") ;;
  --purge) PURGE=yes ;;
  *) die "usage: ${0##*/} [--purge]" ;;
esac
[[ $(id -u) == 1000 ]] || die "the development runtime belongs to UID 1000"
if [[ $PURGE == yes ]]; then
  printf 'This permanently deletes the development database, its secrets and the tooling image.\n'
  printf 'Type "purge s2-assets-qdev" to continue: '
  IFS= read -r reply || reply=
  [[ $reply == 'purge s2-assets-qdev' ]] || die "not confirmed: nothing was changed"
fi

systemctl --user stop "$WEB" "$API" "$DB" 2>/dev/null || :
for u in "${UNITS[@]}"; do rm -f -- "$UNIT_DIR/$u"; done
systemctl --user daemon-reload
note "runtime stopped and its units removed"
if [[ $PURGE == no ]]; then
  note "kept: volume, secrets, tooling image, $STATE_DIR and $SRC (re-run the installer to bring the runtime back)"
  exit 0
fi

podman rm --force --ignore "$WEB_CTR" "$API_CTR" "$DB_CTR" >/dev/null
if podman volume exists "$DB_VOLUME"; then podman volume rm "$DB_VOLUME" >/dev/null; note "deleted volume $DB_VOLUME"; fi
for s in "${SECRETS[@]}"; do
  if podman secret exists "$s"; then podman secret rm "$s" >/dev/null; note "deleted secret $s"; fi
done
if podman network exists "$NETWORK"; then podman network rm "$NETWORK" >/dev/null; note "deleted network $NETWORK"; fi
if podman image exists "$TOOLING"; then podman image rm "$TOOLING" >/dev/null; note "deleted image $TOOLING"; fi
rm -f -- "$STATE_DIR/db-first-init" "$SRC/node_modules/.s2-assets-qdev-deps"
note "purged; kept $SRC and $STATE_DIR/backups"
