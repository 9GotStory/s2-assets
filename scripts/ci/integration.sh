#!/usr/bin/env bash
# Runs the PostgreSQL integration tests as the CI `integration` job does, in CI and locally.
#
#   scripts/ci/integration.sh [--remove-images] [vitest arguments]
#
# Without vitest arguments it runs tests/integration. The steps:
#   1. build the runner image (deploy/podman/integration.Containerfile) and install the frozen
#      lockfile;
#   2. run vitest in the runner, against the rootless Podman socket that DOCKER_HOST names. When
#      DOCKER_HOST names no unix socket, start a private Podman service for the run and stop it
#      afterwards;
#   3. remove every Testcontainers container the run left behind, and fail if one remains.
# --remove-images also removes the two runner images afterwards, as CI does.
set -euo pipefail
cd "$(dirname "$0")/../.."

DEV_IMAGE=s2-assets-dev:ci
RUNNER_IMAGE=s2-assets-integration:ci
POSTGRES_IMAGE=postgres:18.6-alpine
# Each test file starts its own PostgreSQL container. Eight at once on an 8-core host timed out a
# 60-second beforeAll; four matches the four vCPUs of a CI runner.
MAX_WORKERS=${VITEST_MAX_WORKERS:-4}

remove_images=false
if [[ ${1:-} == --remove-images ]]; then
  remove_images=true
  shift
fi
(($#)) || set -- tests/integration

note() { echo "integration.sh: $*"; }

service_pid=
if [[ ${DOCKER_HOST:-} == unix://* ]]; then
  socket=${DOCKER_HOST#unix://}
else
  socket=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/s2-assets-integration/podman.sock
  mkdir -p "${socket%/*}"
  podman system service --time=0 "unix://$socket" &
  service_pid=$!
  for _ in {1..40}; do
    [[ -S $socket ]] && break
    sleep 0.25
  done
fi
stop_service() {
  [[ -n $service_pid ]] || return 0
  kill "$service_pid" 2>/dev/null || true
  wait "$service_pid" 2>/dev/null || true
  rm -f "$socket"
  rmdir "${socket%/*}" 2>/dev/null || true
}
trap stop_service EXIT
[[ -S $socket ]] || { note "no Podman socket at $socket" >&2; exit 1; }

note "building $DEV_IMAGE and $RUNNER_IMAGE"
podman build --quiet -f deploy/podman/dev.Containerfile -t "$DEV_IMAGE" deploy/podman >/dev/null
podman build --quiet -f deploy/podman/integration.Containerfile -t "$RUNNER_IMAGE" deploy/podman >/dev/null

# Testcontainers asks for the short name; tag it where the host does not resolve it to docker.io.
if ! podman image exists "$POSTGRES_IMAGE"; then
  podman pull --quiet "docker.io/library/$POSTGRES_IMAGE" >/dev/null
  podman image exists "$POSTGRES_IMAGE" || podman tag "docker.io/library/$POSTGRES_IMAGE" "$POSTGRES_IMAGE"
fi

lockfile=$(sha256sum pnpm-lock.yaml)
podman run --rm --userns=keep-id --security-opt label=disable -v "$PWD:/work" -w /work \
  "$RUNNER_IMAGE" pnpm install --frozen-lockfile
[[ $(sha256sum pnpm-lock.yaml) == "$lockfile" ]] || { note "pnpm install changed pnpm-lock.yaml" >&2; exit 1; }

test_containers() { podman ps -aq --no-trunc --filter label=org.testcontainers=true | sort; }
before=$(test_containers)

status=0
podman run --rm --name "s2-assets-integration-$$" \
  --network=host --userns=keep-id --security-opt label=disable \
  -v "$PWD:/work" -v "$socket:$socket" -w /work \
  -e DOCKER_HOST="unix://$socket" \
  -e CONTAINER_HOST="unix://$socket" \
  -e TESTCONTAINERS_RYUK_DISABLED=true \
  -e TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1 \
  -e CI=true \
  "$RUNNER_IMAGE" pnpm --filter api exec vitest run --maxWorkers="$MAX_WORKERS" "$@" || status=$?

failures=0
for id in $(comm -13 <(printf '%s\n' "$before") <(test_containers)); do
  note "removing test container $id"
  podman rm -f "$id" >/dev/null || failures=$((failures + 1))
done
leaked=$(comm -13 <(printf '%s\n' "$before") <(test_containers))
if [[ -n $leaked ]]; then
  note "test containers still present: $leaked" >&2
  failures=$((failures + 1))
fi

if $remove_images; then
  podman rmi -f "$RUNNER_IMAGE" "$DEV_IMAGE" >/dev/null || true
  for image in "$RUNNER_IMAGE" "$DEV_IMAGE"; do
    if podman image exists "$image"; then
      note "image $image still present" >&2
      failures=$((failures + 1))
    fi
  done
fi

if ((status != 0)); then
  note "tests failed (exit $status)" >&2
  exit "$status"
fi
if ((failures > 0)); then
  note "cleanup failed ($failures)" >&2
  exit 1
fi
note "tests passed; no test container left behind"
