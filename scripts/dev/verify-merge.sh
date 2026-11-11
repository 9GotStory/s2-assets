#!/usr/bin/env bash
# Checks a merged pull request the way CLAUDE.md (Merges) asks, after `gh pr merge`:
#
#   scripts/dev/verify-merge.sh <pull request number>
#
# Fetches origin, then checks that the merge commit's second parent is the pull request's head and that
# the merge commit changes exactly the pull request's files, compared by full path (`git diff --stat`
# shortens a long path, which made PR #106's check look wrong). Exits 0 when both hold, 1 when either
# fails or the pull request is not merged, 2 for a usage error.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPO=9GotStory/s2-assets
note() { echo "${0##*/}: $*" >&2; }

if (($# != 1)) || [[ ! $1 =~ ^[0-9]+$ ]]; then
  note 'usage: verify-merge.sh <pull request number>'
  exit 2
fi
pr=$1

read -r state head merge < <(gh pr view "$pr" --repo "$REPO" --json state,headRefOid,mergeCommit \
  -q '[.state, .headRefOid, (.mergeCommit.oid // "-")] | join(" ")')
if [[ $state != MERGED ]]; then
  note "FAIL: pull request #$pr is $state, not merged"
  exit 1
fi
git fetch --quiet origin

second_parent=$(git rev-parse "$merge^2")
if [[ $second_parent != "$head" ]]; then
  note "FAIL: merge $merge has second parent $second_parent, not the pull request's head $head"
  exit 1
fi

if ! diff <(gh api --paginate "repos/$REPO/pulls/$pr/files" -q '.[].filename' | sort) \
  <(git diff --name-only "$merge^1" "$merge" | sort); then
  note "FAIL: merge $merge changes other files than pull request #$pr (< pull request, > merge)"
  exit 1
fi

note "PASS: merge $merge of #$pr has second parent $head and changes exactly its $(git diff --name-only "$merge^1" "$merge" | wc -l) files"
