#!/usr/bin/env bash
# Runs the API unit tests as the CI `quality-and-build` job does, without its lint, typecheck and builds.
#
#   scripts/ci/unit.sh [vitest arguments]
#
# Without vitest arguments it runs tests/unit, for example `scripts/ci/unit.sh tests/unit/<file> -t <name>`.
# The steps: build the tooling image; install the frozen lockfile; run vitest uncoloured.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/ci/common.sh
. scripts/ci/common.sh

note "building s2-assets-dev:ci"
podman build --quiet -f deploy/podman/dev.Containerfile -t s2-assets-dev:ci deploy/podman >/dev/null

lockfile=$(sha256sum pnpm-lock.yaml)
podman run --rm --userns=keep-id --security-opt label=disable -v "$PWD:/work" -w /work \
  s2-assets-dev:ci pnpm install --frozen-lockfile >/dev/null
[[ $(sha256sum pnpm-lock.yaml) == "$lockfile" ]] || { note "pnpm install changed pnpm-lock.yaml" >&2; exit 1; }

api_unit_tests "$@"
