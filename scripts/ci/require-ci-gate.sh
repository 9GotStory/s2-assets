#!/usr/bin/env bash
# A Claude Code PreToolUse hook on `gh pr merge`: refuses the merge until CI Gate has passed on the
# commit the command names. This repository's GitHub plan offers no branch protection, so GitHub
# itself would merge through a red gate.
#
# It reads the hook's JSON on stdin. Exit 0 lets the command run; exit 2 refuses it and says why on
# stderr. Whatever it cannot establish refuses the merge. The Product Owner registers it in
# .claude/settings.local.json: PreToolUse, matcher "Bash", if "Bash(gh pr merge *)", onFailure "block",
# command "$CLAUDE_PROJECT_DIR/scripts/ci/require-ci-gate.sh".
set -uo pipefail

REPO=9GotStory/s2-assets

refuse() {
  echo "require-ci-gate: $*" >&2
  exit 2
}

tool_command=$(jq -er '.tool_input.command') || refuse "cannot read the command from the hook input"

newline=$'\n'
merge_pattern="(^|[;&|(${newline}])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|\$)"
[[ $tool_command =~ $merge_pattern ]] || exit 0

number_pattern='gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+([0-9]+)([[:space:]]|$)'
[[ $tool_command =~ $number_pattern ]] \
  || refuse "name the pull request by number: gh pr merge <n> --repo $REPO --merge --match-head-commit <headRefOid>"
number=${BASH_REMATCH[1]}

head_pattern='--match-head-commit[[:space:]=]+([0-9a-f]{40})([[:space:]]|$)'
[[ $tool_command =~ $head_pattern ]] || refuse "name the full head commit: --match-head-commit <headRefOid>"
named_head=${BASH_REMATCH[1]}

pull_request=$(gh pr view "$number" --repo "$REPO" --json headRefOid,baseRefName,statusCheckRollup) \
  || refuse "cannot read pull request #$number from GitHub"

head=$(jq -r '.headRefOid' <<<"$pull_request")
[[ $head == "$named_head" ]] || refuse "the head of #$number is $head, and the command names $named_head"

# CI runs only on pull requests into these bases (ci.yml). On any other, the Checks section of
# CLAUDE.md makes the local results recorded in the pull request its check.
base=$(jq -r '.baseRefName' <<<"$pull_request")
[[ $base == main || $base == feature/* ]] || exit 0

gate=$(jq -r '
  [(.statusCheckRollup // [])[] | select(.name == "CI Gate")]
  | if length == 0 then "missing"
    elif all(.status == "COMPLETED" and .conclusion == "SUCCESS") then "passed"
    else "not-passed" end
' <<<"$pull_request")

case $gate in
  passed) exit 0 ;;
  missing) refuse "CI Gate has not reported on $head yet" ;;
  *)
    jobs=$(jq -r '[(.statusCheckRollup // [])[] | "\(.name)=\(if (.conclusion // "") == "" then .status else .conclusion end)"] | join(", ")' <<<"$pull_request")
    refuse "CI Gate has not passed on $head: $jobs"
    ;;
esac
