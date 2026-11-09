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
# shellcheck source=scripts/ci/common.sh
. scripts/ci/common.sh

DEV_IMAGE=s2-assets-dev:ci
RUNNER_IMAGE=s2-assets-integration:ci
# Each test file starts its own PostgreSQL container. Eight at once on an 8-core host timed out a
# 60-second beforeAll; four matches the four vCPUs of a CI runner.
MAX_WORKERS=${VITEST_MAX_WORKERS:-4}

remove_images=false
if [[ ${1:-} == --remove-images ]]; then
  remove_images=true
  shift
fi
(($#)) || set -- tests/integration

use_podman_socket

note "building $DEV_IMAGE and $RUNNER_IMAGE"
podman build --quiet -f deploy/podman/dev.Containerfile -t "$DEV_IMAGE" deploy/podman >/dev/null
podman build --quiet -f deploy/podman/integration.Containerfile -t "$RUNNER_IMAGE" deploy/podman >/dev/null

ensure_postgres_image

lockfile=$(sha256sum pnpm-lock.yaml)
# The runner image is USER root, which keep-id maps to a subuid: node_modules would stop being the host user's.
podman run --rm --userns=keep-id --security-opt label=disable -v "$PWD:/work" -w /work \
  "$DEV_IMAGE" pnpm install --frozen-lockfile
[[ $(sha256sum pnpm-lock.yaml) == "$lockfile" ]] || { note "pnpm install changed pnpm-lock.yaml" >&2; exit 1; }

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
  -e NO_COLOR=1 \
  "$RUNNER_IMAGE" pnpm --filter api exec vitest run --maxWorkers="$MAX_WORKERS" "$@" || status=$?

failures=0
remove_new_test_containers "$before"

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
