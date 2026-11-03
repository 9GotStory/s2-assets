#!/usr/bin/env bash
# s2-assets development runtime — INSTALLER (UID-1000 rootless Podman + systemd Quadlet).
# Converges this host to the development runtime described in
# docs/operations/development-runtime.md and is safe to re-run: every step checks the real
# state first and only adds what is missing. It never deletes data, never adopts a foreign or
# half-made resource, and never touches another project's runtime or the retired UID-1001
# runtime.
#   scripts/dev-runtime-install.sh --sha <40-hex commit to run>
# Run it from any checkout of this repository: it clones or verifies the runtime checkout at
# that commit, then continues with the installer of that commit, so the runtime is always
# defined by exactly one promoted commit.
set -Eeuo pipefail
set +a                         # an inherited allexport must never export generated credentials
umask 077
# shellcheck source=scripts/dev-runtime-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/dev-runtime-common.sh"
# Report unexpected failures once, from the main shell (not from command substitutions).
trap '[[ $BASH_SUBSHELL == 0 ]] && die "unexpected failure (line $LINENO): $BASH_COMMAND"' ERR

SHA=''
while (( $# )); do
  case $1 in
    --sha) (( $# >= 2 )) || die "usage: ${0##*/} --sha <40-hex commit>"; SHA=$2; shift 2 ;;
    *) die "usage: ${0##*/} --sha <40-hex commit>" ;;
  esac
done
require_sha "$SHA"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

preflight() {
  local c st pair port svc
  [[ $(id -u) == 1000 ]] || die "the development runtime belongs to UID 1000"
  for c in podman systemctl git curl openssl ss sha256sum comm; do
    command -v "$c" >/dev/null || die "required command not found: $c"
  done
  [[ -x $QUADLET ]] || die "Quadlet generator not found at $QUADLET"
  [[ ${XDG_CONFIG_HOME:-$HOME/.config} == "$HOME/.config" ]] \
    || die "XDG_CONFIG_HOME must be the default ~/.config: the units use %h-relative paths"
  st=$(systemctl --user is-system-running 2>/dev/null) || :
  case $st in
    running|degraded) ;;
    *) die "the systemd user manager is not ready (state: ${st:-unknown}); log in to a session first" ;;
  esac
  for pair in "$API_PORT:$API" "$WEB_PORT:$WEB"; do
    port=${pair%%:*} svc=${pair#*:}
    if ! systemctl --user is-active --quiet "$svc" && [[ -n $(ss -Htln "sport = :$port") ]]; then
      die "port $port is already in use by another process"
    fi
  done
}

ensure_checkout() {
  local origin
  if [[ ! -e $SRC ]]; then
    origin=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir) \
      || die "run this script from a checkout of the repository"
    note "cloning the runtime source checkout into $SRC"
    (umask 022 && git clone --quiet --no-checkout "$origin" "$SRC")
    if ! (umask 022 && git -C "$SRC" checkout --quiet --detach "$SHA"); then
      rm -rf -- "$SRC"            # created by this run and never checked out: nothing to keep
      die "commit $SHA is not reachable from the repository's branches (commit and branch it first)"
    fi
  fi
  [[ -d $SRC/.git ]] || die "$SRC must be a full clone (not a worktree): only it is bind-mounted"
  [[ $(git -C "$SRC" rev-parse HEAD) == "$SHA" ]] \
    || die "$SRC is at another commit: move it with scripts/dev-runtime-update.sh --sha $SHA"
  [[ -z $(git -C "$SRC" status --porcelain --untracked-files=no) ]] \
    || die "$SRC has modified tracked files: the runtime only serves a clean promoted commit"
  if git -C "$SRC" symbolic-ref -q HEAD >/dev/null; then
    git -C "$SRC" checkout --quiet --detach "$SHA"   # same commit, detached like every promotion
  fi
  if [[ -e $SRC/$MARKER ]]; then
    [[ $(<"$SRC/$MARKER") == "$SHA" ]] \
      || die "$SRC/$MARKER names another commit: promote with scripts/dev-runtime-update.sh"
  else
    printf '%s\n' "$SHA" > "$SRC/$MARKER"
  fi
  note "runtime source: $SRC @ $SHA"
}

app_running() { systemctl --user is-active --quiet "$API" || systemctl --user is-active --quiet "$WEB"; }

ensure_images() {
  local db_img want have=''
  db_img=$(sed -n 's/^Image=//p' "$SRC/deploy/dev-quadlet/s2-assets-dev-db.container")
  [[ $db_img == *@sha256:* ]] || die "database image is not pinned by digest: $db_img"
  if ! podman image exists "$db_img"; then
    note "pulling $db_img"
    podman pull --quiet "$db_img" >/dev/null
  fi
  want=$(sha256sum < "$SRC/deploy/podman/dev.Containerfile" | cut -d' ' -f1)
  if podman image exists "$TOOLING"; then
    have=$(podman image inspect --format "{{index .Labels \"$TOOLING_LABEL\"}}" "$TOOLING")
  fi
  if [[ $have == "$want" ]]; then
    note "tooling image: up to date"
    return
  fi
  ! app_running || die "the tooling image must be rebuilt while the runtime runs: use scripts/dev-runtime-update.sh"
  note "building $TOOLING from deploy/podman/dev.Containerfile"
  podman build --quiet --pull=missing --label "$TOOLING_LABEL=$want" -t "$TOOLING" \
    -f "$SRC/deploy/podman/dev.Containerfile" "$SRC/deploy/podman" >/dev/null
}

ensure_dependencies() {
  local stamp=$SRC/node_modules/.s2-assets-qdev-deps want lock
  lock=$(sha256sum < "$SRC/pnpm-lock.yaml" | cut -d' ' -f1)
  want="$lock $(podman image inspect --format '{{.Id}}' "$TOOLING")"
  if [[ -f $stamp && $(<"$stamp") == "$want" ]]; then
    note "dependencies: up to date"
    return
  fi
  ! app_running || die "dependencies must be reinstalled while the runtime runs: use scripts/dev-runtime-update.sh"
  note "installing dependencies (pnpm install --frozen-lockfile) in a temporary container"
  podman run --rm --replace --pull=never --name s2-assets-qdev-install --userns=keep-id \
    -v "$SRC:/work:z" -w /work "$TOOLING" pnpm install --frozen-lockfile
  [[ $(sha256sum < "$SRC/pnpm-lock.yaml" | cut -d' ' -f1) == "$lock" ]] \
    || die "pnpm install changed pnpm-lock.yaml: the frozen lockfile was not honoured"
  [[ -e $SRC/apps/api/node_modules/fastify && -e $SRC/apps/web/node_modules/vite ]] \
    || die "pnpm install finished without installing the API and Web dependencies"
  printf '%s\n' "$want" > "$stamp"
}

ensure_secrets() {
  local s n=0 db_pw cookie
  for s in "${SECRETS[@]}"; do
    if podman secret exists "$s"; then n=$((n + 1)); fi
  done
  if (( n == ${#SECRETS[@]} )); then note "secrets: present"; return; fi
  (( n == 0 )) || die "only $n of ${#SECRETS[@]} runtime secrets exist (an interrupted install): run scripts/dev-runtime-uninstall.sh --purge, then install again"
  if podman volume exists "$DB_VOLUME" && db_has_cluster; then
    die "the database volume holds a cluster but its secrets are gone: restore them, or purge with scripts/dev-runtime-uninstall.sh --purge"
  fi
  db_pw=$(openssl rand -hex 24)
  cookie=$(openssl rand -hex 32)        # the Feature 001 rule: hex, at least 32 bytes
  [[ $db_pw =~ ^[0-9a-f]{48}$ && $cookie =~ ^[0-9a-f]{64}$ ]] || die "credential generation failed"
  # Values travel only through stdin pipes from shell builtins: never argv, env or output.
  printf '%s' "$db_pw" | podman secret create --label "$LABEL" s2-assets-qdev-db-password - >/dev/null
  printf '%s' "postgresql://$DB_NAME:$db_pw@$DB_CTR:5432/$DB_NAME" \
    | podman secret create --label "$LABEL" s2-assets-qdev-database-url - >/dev/null
  printf '%s' "$cookie" | podman secret create --label "$LABEL" s2-assets-qdev-cookie-secret - >/dev/null
  db_pw='' cookie=''
  note "secrets: created (${#SECRETS[@]} podman secrets)"
}

ensure_volume() {
  if ! podman volume exists "$DB_VOLUME"; then
    podman volume create --label "$LABEL" "$DB_VOLUME" >/dev/null
    note "volume $DB_VOLUME: created"
    return
  fi
  [[ $(podman volume inspect --format '{{index .Labels "io.s2-assets.runtime"}}' "$DB_VOLUME") == qdev ]] \
    || die "volume $DB_VOLUME exists without the $LABEL label: refusing to adopt a volume this installer did not create"
  note "volume $DB_VOLUME: present"
}

install_units() {
  local u d svc changed=()
  mkdir -p -- "$UNIT_DIR" "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  for u in "${UNITS[@]}"; do
    cmp -s -- "$SRC/deploy/dev-quadlet/$u" "$UNIT_DIR/$u" && continue
    install -m 0644 -- "$SRC/deploy/dev-quadlet/$u" "$UNIT_DIR/$u"
    changed+=("$u")
  done
  d=$(mktemp -d)
  "$QUADLET" -dryrun -user >"$d/out" 2>"$d/err" || :
  for u in "$DB" "$API" "$WEB"; do
    if ! grep -qxF -- "---$u---" "$d/out"; then
      grep -F s2-assets-dev "$d/err" >&2 || :
      rm -rf -- "$d"
      die "Quadlet did not generate $u from the installed units"
    fi
  done
  rm -rf -- "$d"
  systemctl --user daemon-reload
  if (( ${#changed[@]} )); then
    note "units installed or updated: ${changed[*]}"
    # A running service only picks up a changed unit when restarted.
    for u in "${changed[@]}"; do
      case $u in
        s2-assets-dev-db.container) svc=$DB ;;
        s2-assets-dev-api.container) svc=$API ;;
        s2-assets-dev-web.container) svc=$WEB ;;
        *) continue ;;
      esac
      if systemctl --user is-active --quiet "$svc"; then systemctl --user restart "$svc"; fi
    done
  else
    note "units: up to date"
  fi
}

start_db() {
  if ! db_has_cluster; then
    : > "$STATE_DIR/db-first-init"      # authorizes exactly this first initialization
    note "starting $DB (first start: initializing the database cluster)"
  fi
  systemctl --user start "$DB" || die "$DB failed to start: journalctl --user -u $DB -n 50"
  [[ $(db_sql 'SELECT 1') == 1 ]] || die "the database does not answer: journalctl --user -u $DB -n 50"
  rm -f -- "$STATE_DIR/db-first-init"
  note "database: ready ($DB_NAME)"
}

migrate() { # the Feature 001 explicit migration (packages/db migrator), as a one-off container
  local pending
  note "applying pending migrations (pnpm --filter db migrate:latest)"
  podman run --rm --replace --pull=never --name s2-assets-qdev-migrate --userns=keep-id \
    --network "$NETWORK" --secret s2-assets-qdev-database-url,type=env,target=DATABASE_URL \
    -v "$SRC:/work:z" -w /work "$TOOLING" pnpm --filter db migrate:latest \
    || die "migration failed: the database keeps every migration that completed"
  pending=$(pending_migrations) || die "could not read the applied migrations"
  [[ -z $pending ]] || die "migrations still pending after migrate:latest: $pending"
}

start_app() {
  local svc
  for svc in "$API" "$WEB"; do
    if systemctl --user is-active --quiet "$svc"; then note "$svc: running"; continue; fi
    note "starting $svc"
    systemctl --user start "$svc" || die "$svc failed to start: journalctl --user -u $svc -n 80"
  done
}

preflight
ensure_checkout
if [[ $HERE != "$(cd "$SRC" && pwd -P)" ]]; then
  note "continuing with the installer of the promoted commit"
  exec "$SRC/scripts/dev-runtime-install.sh" --sha "$SHA"
fi
ensure_images
ensure_dependencies
ensure_secrets
ensure_volume
install_units
start_db
migrate
start_app
"$SRC/scripts/dev-runtime-verify.sh" || die "verification failed: see the FAIL lines above"
cat <<EOF

s2-assets development runtime is ready:
  Web:                  $WEB_ORIGIN/
  API:                  $API_ORIGIN/health
  Logs:                 journalctl --user -u $API -f   (and $WEB, $DB)
  Promote a new commit: $SRC/scripts/dev-runtime-update.sh --sha <commit>
EOF
