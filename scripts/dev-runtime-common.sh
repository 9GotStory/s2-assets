# shellcheck shell=bash disable=SC2034  # the variables are used by the sourcing scripts
# s2-assets development runtime — shared definitions for the dev-runtime-*.sh scripts.
# Sourced, never executed: one place for names, paths and helpers so the installer, updater,
# verifier and uninstaller cannot drift apart.
# Contract: docs/operations/development-runtime.md.

export LC_ALL=C                                   # stable tool output (the host locale is th_TH)

SRC=$HOME/dev/s2-assets-quadlet                   # runtime source checkout, bind-mounted at /work
UNIT_DIR=$HOME/.config/containers/systemd         # rootless Quadlet search path
STATE_DIR=$HOME/.local/state/s2-assets-qdev       # first-initialization flag, backups
MARKER=.s2-assets-qdev-source-identity            # the promoted commit of the runtime checkout
QUADLET=/usr/libexec/podman/quadlet
API_PORT=3010
WEB_PORT=5180
API_ORIGIN=http://127.0.0.1:$API_PORT
WEB_ORIGIN=http://127.0.0.1:$WEB_PORT
DB=s2-assets-dev-db.service
API=s2-assets-dev-api.service
WEB=s2-assets-dev-web.service
DB_CTR=s2-assets-qdev-db
API_CTR=s2-assets-qdev-api
WEB_CTR=s2-assets-qdev-web
DB_NAME=s2_assets_qdev                            # the database and its owner role
DB_VOLUME=s2-assets-qdev-db-data
NETWORK=s2-assets-qdev
LABEL=io.s2-assets.runtime=qdev
# Built locally from deploy/podman/dev.Containerfile (the Feature 001 development tooling
# image); the label records which Containerfile built it, so a changed one is rebuilt.
TOOLING=localhost/s2-assets-qdev-tooling:latest
TOOLING_LABEL=io.s2-assets.containerfile-sha256
UNITS=(s2-assets-dev.network s2-assets-dev-db-data.volume s2-assets-dev-db.container
  s2-assets-dev-api.container s2-assets-dev-web.container)
SECRETS=(s2-assets-qdev-db-password s2-assets-qdev-database-url s2-assets-qdev-cookie-secret)

die()  { printf '%s: FAIL: %s\n' "${0##*/}" "$*" >&2; exit 1; }
note() { printf '%s: %s\n' "${0##*/}" "$*"; }

require_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]] || die "--sha must name a full 40-hex commit"; }
volume_path() { podman volume inspect --format '{{.Mountpoint}}' "$1"; }
db_has_cluster() { # the data volume holds an initialized PostgreSQL 18 cluster
  local p
  p=$(volume_path "$DB_VOLUME") && podman unshare test -e "$p/18/docker/PG_VERSION"
}
db_sql() { # db_sql SQL — one query as the owner role over the container's local socket
  podman exec "$DB_CTR" psql -X -q -At -v ON_ERROR_STOP=1 -U "$DB_NAME" -d "$DB_NAME" -c "$1"
}
pending_migrations() { # prints the migration files of the checkout that the database has not applied
  local f files=() applied
  for f in "$SRC"/packages/db/src/migrations/*.ts; do f=${f##*/}; files+=("${f%.ts}"); done
  applied=$(db_sql 'SELECT name FROM kysely_migration' | sort) || return 1
  comm -23 <(printf '%s\n' "${files[@]}" | sort) <(printf '%s\n' "$applied")
}
