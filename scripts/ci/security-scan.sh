#!/usr/bin/env bash
# Runs the CI `security-scan` job, in CI and locally: Trivy on the lockfile, the production API image
# and the migration image, failing on any HIGH or CRITICAL finding. Every scan runs, so one run lists
# everything there is to fix.
#
#   scripts/ci/security-scan.sh [--remove-images]
#
# --remove-images also removes the two built images afterwards, as CI does.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/ci/common.sh
. scripts/ci/common.sh

TRIVY_IMAGE=docker.io/aquasec/trivy:0.76.0
API_IMAGE=s2-assets-api:ci
MIGRATION_IMAGE=s2-assets-migration:ci

remove_images=false
if [[ ${1:-} == --remove-images ]]; then
  remove_images=true
fi

scan_dir=$(mktemp -d)
finish() {
  local status=$?
  rm -rf "$scan_dir"
  if $remove_images; then
    podman rmi -f "$API_IMAGE" "$MIGRATION_IMAGE" >/dev/null 2>&1 || true
    for image in "$API_IMAGE" "$MIGRATION_IMAGE"; do
      if podman image exists "$image"; then
        note "image $image still present" >&2
        status=1
      fi
    done
  fi
  exit "$status"
}
trap finish EXIT

note "building $API_IMAGE and $MIGRATION_IMAGE"
podman build --quiet -f deploy/podman/api.Containerfile -t "$API_IMAGE" . >/dev/null
podman build --quiet -f deploy/podman/migration.Containerfile -t "$MIGRATION_IMAGE" . >/dev/null
podman save --quiet "$API_IMAGE" -o "$scan_dir/api-image.tar"
podman save --quiet "$MIGRATION_IMAGE" -o "$scan_dir/migration-image.tar"
cp pnpm-lock.yaml "$scan_dir/"

found=()
# --table-mode detailed leaves out the summary table, which has a row for every package.json.
scan() {
  local label=$1
  shift
  note "scanning $label"
  podman run --rm --security-opt label=disable -v "$scan_dir:/scan:ro" "$TRIVY_IMAGE" "$@" \
    --quiet --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --table-mode detailed \
    || found+=("$label")
}
scan "the lockfile" fs --include-dev-deps /scan/pnpm-lock.yaml
scan "the API image" image --input /scan/api-image.tar
scan "the migration image" image --input /scan/migration-image.tar

if ((${#found[@]})); then
  note "findings, or a failed scan, in: ${found[*]}" >&2
  exit 1
fi
note "passed; no HIGH or CRITICAL finding"
