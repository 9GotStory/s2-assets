#!/usr/bin/env bash
# Runs the checks and builds of the CI `quality-and-build` job, in CI and locally.
#
#   scripts/ci/quality.sh [--quick] [--base <rev>] [--remove-images]
#
# The steps: build the tooling image and assert its Node and pnpm; install the frozen lockfile; lint;
# typecheck; API unit tests; the API and Web production builds; the API and migration images.
#   --quick          stop after the typecheck, for the implementation loop.
#   --base <rev>     first run `git diff --check` and scripts/check-glossary.sh against <rev>.
#   --remove-images  remove the three images afterwards, as CI does.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/ci/common.sh
. scripts/ci/common.sh

DEV_IMAGE=s2-assets-dev:ci
API_IMAGE=s2-assets-api:ci
MIGRATION_IMAGE=s2-assets-migration:ci

quick=false
base=
remove_images=false
while (($#)); do
  case $1 in
    --quick) quick=true; shift ;;
    --base) base=${2:?--base needs a revision}; shift 2 ;;
    --remove-images) remove_images=true; shift ;;
    *) note "unknown argument: $1" >&2; exit 2 ;;
  esac
done

finish() {
  local status=$?
  if $remove_images; then
    podman rmi -f "$DEV_IMAGE" "$API_IMAGE" "$MIGRATION_IMAGE" >/dev/null 2>&1 || true
    for image in "$DEV_IMAGE" "$API_IMAGE" "$MIGRATION_IMAGE"; do
      if podman image exists "$image"; then
        note "image $image still present" >&2
        status=1
      fi
    done
  fi
  if ((status != 0)); then
    note "failed (exit $status)" >&2
  else
    note "passed"
  fi
  exit "$status"
}
trap finish EXIT

in_tooling() { podman run --rm --userns=keep-id --security-opt label=disable -v "$PWD:/work" -w /work "$DEV_IMAGE" "$@"; }

if [[ -n $base ]]; then
  note "diff checks against $base"
  git diff --check "$base" HEAD
  scripts/check-glossary.sh "$base"
fi

note "building $DEV_IMAGE"
podman build --quiet -f deploy/podman/dev.Containerfile -t "$DEV_IMAGE" deploy/podman >/dev/null
[[ $(podman run --rm "$DEV_IMAGE" node --version) == v24.21.0 ]] || { note "the tooling image's Node is not v24.21.0" >&2; exit 1; }
[[ $(podman run --rm "$DEV_IMAGE" pnpm --version) == 12.9.1 ]] || { note "the tooling image's pnpm is not 12.9.1" >&2; exit 1; }

note "frozen install"
lockfile=$(sha256sum pnpm-lock.yaml)
in_tooling pnpm install --frozen-lockfile
[[ $(sha256sum pnpm-lock.yaml) == "$lockfile" ]] || { note "pnpm install changed pnpm-lock.yaml" >&2; exit 1; }

note "lint"
in_tooling pnpm run lint
note "typecheck"
in_tooling pnpm run typecheck
$quick && exit 0

note "API unit tests"
in_tooling pnpm --filter api exec vitest run tests/unit
note "API production build"
in_tooling pnpm --filter api run build
note "Web production build"
in_tooling pnpm --filter web run build

note "building $API_IMAGE and $MIGRATION_IMAGE"
podman build --quiet -f deploy/podman/api.Containerfile -t "$API_IMAGE" . >/dev/null
podman build --quiet -f deploy/podman/migration.Containerfile -t "$MIGRATION_IMAGE" . >/dev/null
