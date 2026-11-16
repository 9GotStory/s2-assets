#!/usr/bin/env bash
# Merges a task's pull request the way CLAUDE.md (Merges) asks, one step after another, stopping at the
# first that fails:
#
#   scripts/dev/merge-pr.sh <pull request number> <headRefOid>
#
# 0. scripts/ci/require-ci-gate.sh, the check the Claude Code hook runs before a `gh pr merge` typed as a
#    command: the hook does not see the merge this script runs, so the script asks it first.
# 1. `gh pr merge --merge --match-head-commit <headRefOid> --delete-branch`, which also deletes the task
#    branch on GitHub. GitHub may answer a 5xx or "Merge already in progress" and still not merge (PR #145:
#    a 502, then "in progress" for over 3 minutes): the script then retries until the pull request is
#    merged or MERGE_LIMIT_S passes.
# 2. `scripts/dev/verify-merge.sh <number>`.
# 3. Checks out the integration branch, pulls it from origin fast-forward only and deletes the local task
#    branch.
#
# <headRefOid> is the head that `scripts/dev/await-ci.sh` printed. Exits 0 when every step passed, 1 when
# one failed, 2 for a usage error.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPO=9GotStory/s2-assets
# How long the merge may keep answering a transient failure before the script gives up.
MERGE_LIMIT_S=${MERGE_LIMIT_S:-600}
RETRY_INTERVAL_S=${RETRY_INTERVAL_S:-20}

note() { echo "${0##*/}: $*" >&2; }

if (($# != 2)) || [[ ! $1 =~ ^[0-9]+$ ]] || [[ ! $2 =~ ^[0-9a-f]{40}$ ]]; then
  note 'usage: merge-pr.sh <pull request number> <headRefOid (40 hex)>'
  exit 2
fi
pr=$1
head_oid=$2

read -r base branch < <(gh pr view "$pr" --repo "$REPO" --json baseRefName,headRefName -q '[.baseRefName, .headRefName] | join(" ")')

state_of() { gh pr view "$pr" --repo "$REPO" --json state -q .state; }

merge=(gh pr merge "$pr" --repo "$REPO" --merge --match-head-commit "$head_oid" --delete-branch)
if [[ $(state_of) != MERGED ]] && ! jq -n --arg command "${merge[*]}" '{tool_input: {command: $command}}' | scripts/ci/require-ci-gate.sh; then
  note "FAIL: CI Gate refused the merge of #$pr"
  exit 1
fi

deadline=$(($(date +%s) + MERGE_LIMIT_S))
while [[ $(state_of) != MERGED ]]; do
  if output=$("${merge[@]}" 2>&1); then
    break
  fi
  if ! grep -qE 'status code: 5[0-9][0-9]|Merge already in progress' <<<"$output"; then
    note "FAIL: merging #$pr: $output"
    exit 1
  fi
  if (($(date +%s) >= deadline)); then
    note "FAIL: #$pr still not merged ${MERGE_LIMIT_S}s on; GitHub last answered: $output"
    exit 1
  fi
  note "GitHub answered a transient failure, retrying in ${RETRY_INTERVAL_S}s: $(head -c 120 <<<"$output" | tr '\n' ' ')"
  sleep "$RETRY_INTERVAL_S"
done
note "merged #$pr"

scripts/dev/verify-merge.sh "$pr"

git checkout --quiet "$base"
git pull --quiet --ff-only origin "$base"
if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
  git branch -d "$branch"
fi
note "PASS: #$pr merged and verified; on $base at $(git rev-parse --short HEAD)"
