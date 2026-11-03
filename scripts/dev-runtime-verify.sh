#!/usr/bin/env bash
# s2-assets development runtime — VERIFY. Read-only: it changes nothing and prints no secret.
# One PASS/FAIL line per check, then VERIFY: PASS, or VERIFY: FAIL with a non-zero exit. Safe
# to run at any time after installation. Contract: docs/operations/development-runtime.md.
set -uo pipefail
set +a
# shellcheck source=scripts/dev-runtime-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/dev-runtime-common.sh"

failed=0
check() { # check DESCRIPTION COMMAND... — the command's output is discarded
  local d=$1
  shift
  if "$@" >/dev/null 2>&1; then printf 'PASS: %s\n' "$d"; else printf 'FAIL: %s\n' "$d"; failed=1; fi
}
healthy() { [[ $(podman inspect --format '{{.State.Health.Status}}' "$1" 2>/dev/null) == healthy ]]; }
status_of() { # status_of URL [ACCEPT] — the HTTP status code of a GET
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -H "Accept: ${2:-*/*}" "$1"
}
ports_ok() {
  [[ $(podman port "$API_CTR") == "3000/tcp -> 127.0.0.1:$API_PORT" \
    && $(podman port "$WEB_CTR") == "5173/tcp -> 127.0.0.1:$WEB_PORT" \
    && -z $(podman port "$DB_CTR") ]]
}
api_ok() { [[ $(status_of "$API_ORIGIN/health") == 200 && $(status_of "$API_ORIGIN/ready") == 200 ]]; }
web_ok() {
  [[ $(status_of "$WEB_ORIGIN/" text/html) == 200 && $(status_of "$WEB_ORIGIN/login" text/html) == 200 ]]
}
# A protected API route answers 401 through the Web proxy; Vite alone would answer 404.
proxy_ok() { [[ $(status_of "$WEB_ORIGIN/system/info" application/json) == 401 ]]; }
migrations_ok() { local p; p=$(pending_migrations) && [[ -z $p ]]; }
source_ok() {
  [[ $(git -C "$SRC" rev-parse HEAD) == "$(<"$SRC/$MARKER")" ]] \
    && [[ -z $(git -C "$SRC" status --porcelain --untracked-files=no) ]]
}
volume_ok() {
  [[ $(podman volume inspect --format '{{index .Labels "io.s2-assets.runtime"}}' "$DB_VOLUME") == qdev ]]
}

check "$DB active" systemctl --user is-active --quiet "$DB"
check "$API active" systemctl --user is-active --quiet "$API"
check "$WEB active" systemctl --user is-active --quiet "$WEB"
check "database container healthy" healthy "$DB_CTR"
check "API container healthy" healthy "$API_CTR"
check "Web container healthy" healthy "$WEB_CTR"
check "published only on 127.0.0.1:$API_PORT (API) and 127.0.0.1:$WEB_PORT (Web); database has no host port" ports_ok
check "API /health and /ready answer 200 at $API_ORIGIN" api_ok
check "Web / and /login answer 200 at $WEB_ORIGIN" web_ok
check "Web dev proxy reaches the API (/system/info answers 401 unauthenticated)" proxy_ok
check "migrations: none pending" migrations_ok
check "database volume carries the $LABEL label" volume_ok
check "runtime source is the promoted commit, clean" source_ok
printf 'runtime source: %s @ %s\n' "$SRC" "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || printf unknown)"
if (( failed )); then echo "VERIFY: FAIL"; exit 1; fi
echo "VERIFY: PASS"
