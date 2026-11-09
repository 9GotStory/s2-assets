#!/usr/bin/env bash
# Runs the Playwright journeys as the CI `browser-e2e` job does, in CI and locally.
#
#   scripts/ci/e2e.sh [--auth] [spec...]     for example: scripts/ci/e2e.sh tests/e2e/assignment.spec.ts
#
# Without a spec it runs every spec except auth.spec.ts. Each of those starts its own Testcontainers
# PostgreSQL, API and Vite server, on the host network and the rootless Podman socket.
#   --auth  also run auth.spec.ts, against the Compose stack that E2E_BASE_URL, E2E_USERNAME and
#           E2E_PASSWORD name. Only CI starts that stack.
#
# The run happens in a copy of the tree at E2E_WORKSPACE (default ~/.cache/s2-assets-e2e), because the
# repository's node_modules hold the tooling image's Alpine builds and the browser runner is glibc.
# The copy keeps its root node_modules between runs, so the install is quick. Each run empties the
# rest of it, so the results of a failed run are copied to E2E_FAILURES (default
# ~/.cache/s2-assets-e2e-failures/<commit>-<UTC>), which keeps the last three.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/ci/common.sh
. scripts/ci/common.sh

IMAGE=s2-assets-browser:ci
WORKSPACE=${E2E_WORKSPACE:-${XDG_CACHE_HOME:-$HOME/.cache}/s2-assets-e2e}
FAILURES=${E2E_FAILURES:-${XDG_CACHE_HOME:-$HOME/.cache}/s2-assets-e2e-failures}

auth=false
if [[ ${1:-} == --auth ]]; then
  auth=true
  shift
fi
if (($# == 0)); then
  for spec in apps/web/tests/e2e/*.spec.ts; do
    [[ $spec == */auth.spec.ts ]] || set -- "$@" "tests/e2e/${spec##*/}"
  done
fi

use_podman_socket

note "building $IMAGE"
podman build --quiet -f deploy/podman/browser.Containerfile -t "$IMAGE" deploy/podman >/dev/null

note "copying the tree to $WORKSPACE"
mkdir -p "$WORKSPACE"
find "$WORKSPACE" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -cf - --exclude=.git --exclude=node_modules --exclude=test-results --exclude=dist . | tar -xf - -C "$WORKSPACE"
test ! -d "$WORKSPACE/.git"
test ! -d "$WORKSPACE/apps/web/node_modules"

note "asserting the runner's versions, and installing the frozen lockfile in it"
podman run --rm --security-opt label=disable -v "$WORKSPACE:/work" -w /work "$IMAGE" bash -c '
  set -euo pipefail
  test "$(node -v)" = "v24.21.0"
  test "$(pnpm -v)" = "12.9.1"
  LOCK_BEFORE=$(sha256sum pnpm-lock.yaml)
  pnpm install --frozen-lockfile
  test "$LOCK_BEFORE" = "$(sha256sum pnpm-lock.yaml)"
  pnpm --filter web exec playwright --version | grep -Eq "1\.63\.0"
'

ensure_postgres_image
before=$(test_containers)

# Every run happens, and the job fails once with all the results.
status=0
if $auth; then
  : "${E2E_BASE_URL:?--auth needs E2E_BASE_URL}" "${E2E_USERNAME:?--auth needs E2E_USERNAME}" "${E2E_PASSWORD:?--auth needs E2E_PASSWORD}"
  # The browser reaches the Web through its loopback port, as the readiness probes do: joining the
  # Compose network made the Web container's DNS lose `api` (EAI_AGAIN).
  note "running tests/e2e/auth.spec.ts against the Compose stack"
  podman run --rm --network=host --ipc=host --security-opt label=disable \
    -v "$WORKSPACE:/work" -w /work \
    -e E2E_BASE_URL -e E2E_USERNAME -e E2E_PASSWORD -e CI=true \
    "$IMAGE" pnpm --filter web exec playwright test tests/e2e/auth.spec.ts --output test-results/auth \
    || status=1
fi

note "running $*"
podman run --rm --network=host --ipc=host --security-opt label=disable \
  -v "$WORKSPACE:/work" -v "$socket:$socket" -w /work \
  -e DOCKER_HOST="unix://$socket" \
  -e TESTCONTAINERS_RYUK_DISABLED=true \
  -e TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1 \
  -e CI=true \
  "$IMAGE" pnpm --filter web exec playwright test "$@" --output test-results/journeys \
  || status=1

failures=0
remove_new_test_containers "$before"

if ((status != 0)); then
  kept="$FAILURES/$(git rev-parse --short HEAD)-$(LC_ALL=C date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$kept"
  cp -r "$WORKSPACE/apps/web/test-results/." "$kept/" || note "could not copy the results to $kept" >&2
  ls -1dt "$FAILURES"/*/ | tail -n +4 | xargs -r rm -rf --
  note "journeys failed; results in $kept" >&2
  exit "$status"
fi
if ((failures > 0)); then
  note "cleanup failed ($failures)" >&2
  exit 1
fi
note "journeys passed; no test container left behind"
