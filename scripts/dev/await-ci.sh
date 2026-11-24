#!/usr/bin/env bash
# Waits for the CI run on a pull request's head, then prints each job and the head to merge with.
# CLAUDE.md (Checks): when GitHub has created no run for the head 5 minutes after the pull request
# opened, close and reopen it; this script says so and exits 3.
#
#   scripts/dev/await-ci.sh <pull request number>
#
# Exits 0 when the run succeeded, 1 when it failed, 2 for a usage error, 3 when no run appeared.
set -euo pipefail

REPO=9GotStory/s2-assets
# How long a pull request may go without a run before it is closed and reopened.
NO_RUN_LIMIT_S=300

note() { echo "${0##*/}: $*" >&2; }

[[ ${1:-} =~ ^[0-9]+$ ]] || { note 'usage: await-ci.sh <pull request number>'; exit 2; }
number=$1

head=$(gh pr view "$number" --repo "$REPO" --json headRefOid --jq .headRefOid)
opened=$(gh pr view "$number" --repo "$REPO" --json createdAt --jq .createdAt)
deadline=$(( $(date -d "$opened" +%s) + NO_RUN_LIMIT_S ))

run_id=
while :; do
  run_id=$(gh run list --repo "$REPO" --commit "$head" --event pull_request --json databaseId --jq '.[0].databaseId // empty')
  [[ -n $run_id ]] && break
  if (( $(date +%s) >= deadline )); then
    note "no CI run for $head ${NO_RUN_LIMIT_S}s after #$number opened: close and reopen it (CLAUDE.md, Checks)"
    exit 3
  fi
  sleep 10
done

note "watching run $run_id on $head"
status=0
gh run watch "$run_id" --repo "$REPO" --exit-status >/dev/null 2>&1 || status=1
gh run view "$run_id" --repo "$REPO" --json conclusion,jobs --jq '"run '"$run_id"': \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
echo "headRefOid: $head"
(( status == 0 )) || note "scripts/dev/ci-failure.sh $run_id shows the failed tests and their traces"
exit "$status"
