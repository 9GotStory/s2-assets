#!/usr/bin/env bash
# Checks a merged pull request the way CLAUDE.md (Merges) asks, after `gh pr merge`:
#
#   scripts/dev/verify-merge.sh <pull request number>
#
# Fetches origin, then checks that the merge commit's second parent is the pull request's head and that
# the merge commit changes exactly the pull request's files, compared by full path (`git diff --stat`
# shortens a long path, which made PR #106's check look wrong). Exits 0 when both hold, 1 when either
# fails or the pull request is not merged, 2 for a usage error.
#
# Under load GitHub may answer a 5xx for the pull request's files ("diff is temporarily unavailable", PR
# #249). The script retries that read until READ_LIMIT_S passes, as merge-pr.sh retries the merge, and
# reports a read that still fails as one: an answer that is not a file list is never compared.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPO=9GotStory/s2-assets
# How long the read of the pull request's files may keep answering a 5xx before the script gives up.
READ_LIMIT_S=${READ_LIMIT_S:-300}
RETRY_INTERVAL_S=${RETRY_INTERVAL_S:-20}
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

# Read into a variable first: inside a process substitution, gh's exit status escapes set -e, and PR #249's
# check compared a 500's JSON body as the file list and reported other files changed.
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
deadline=$(($(date +%s) + READ_LIMIT_S))
until pr_files=$(gh api --paginate "repos/$REPO/pulls/$pr/files" -q '.[].filename' 2>"$errors"); do
  answer=$(head -c 200 "$errors" | tr '\n' ' ')
  if ! grep -qE 'HTTP 5[0-9][0-9]' "$errors"; then
    note "FAIL: could not read the files of pull request #$pr: $answer"
    exit 1
  fi
  if (($(date +%s) >= deadline)); then
    note "FAIL: could not read the files of pull request #$pr ${READ_LIMIT_S}s on; GitHub last answered: $answer"
    exit 1
  fi
  note "GitHub answered a transient failure reading the files of #$pr, retrying in ${RETRY_INTERVAL_S}s: $answer"
  sleep "$RETRY_INTERVAL_S"
done

if ! diff <(sed '/^$/d' <<<"$pr_files" | sort) <(git diff --name-only "$merge^1" "$merge" | sort); then
  note "FAIL: merge $merge changes other files than pull request #$pr (< pull request, > merge)"
  exit 1
fi

note "PASS: merge $merge of #$pr has second parent $head and changes exactly its $(git diff --name-only "$merge^1" "$merge" | wc -l) files"
