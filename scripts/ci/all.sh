#!/usr/bin/env bash
# Runs the four jobs that CI Gate requires, in its order, locally, and reports them for a pull
# request's Evidence. Two steps of CI's browser job stay in CI, because only CI starts their Compose
# stack: auth.spec.ts (e2e.sh --auth) and the HTTP smoke test.
#
#   scripts/ci/all.sh [--base <rev>]
#
#   --base <rev>  passed to quality.sh, for `git diff --check` and the glossary check against <rev>.
#
# Every job runs, so one failure does not hide another. Each job's log goes in a new temporary
# directory. The output ends with a Markdown table of the results, and the exit status is non-zero
# when any job failed. Each job takes the host's job lock itself (common.sh), so this script sources
# nothing from there: holding the lock here would leave the first job waiting for it.
set -euo pipefail
cd "$(dirname "$0")/../.."

base=
while (($#)); do
  case $1 in
    --base) base=${2:?--base needs a revision}; shift 2 ;;
    *) echo "all.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
log_dir=$(mktemp -d -t s2-assets-ci.XXXXXX)

status=0
rows=()

# Runs one job: $1 names it, $2 matches the log lines that state its result, the rest is its command.
run_job() {
  local name=$1 pattern=$2 log="$log_dir/$1.log" result=passed detail
  shift 2
  echo "all.sh: $name: running, log in $log"
  "$@" >"$log" 2>&1 || { result=failed; status=1; }
  # vitest and Playwright colour their summary lines.
  detail=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -E "$pattern" | sed -E 's/^ +//; s/ +/ /g; s/ \| /, /g' | awk 'NR > 1 { printf "; " } { printf "%s", $0 }' || true)
  rows+=("| \`$*\` | $result | ${detail:-no result line in the log} |")
  echo "all.sh: $name: $result"
}

quality_args=()
[[ -z $base ]] || quality_args=(--base "$base")

run_job quality '^ *Tests +' scripts/ci/quality.sh "${quality_args[@]}"
run_job integration '^ *(Test Files|Tests) +' scripts/ci/integration.sh
run_job e2e '^ *[0-9]+ (passed|failed|flaky|skipped|did not run)' scripts/ci/e2e.sh
run_job security 'no HIGH or CRITICAL finding|findings, or a failed scan' scripts/ci/security-scan.sh

# Each job logs the commit it tested as its first line.
tested=$(sed -n 's/^quality\.sh: testing //p' "$log_dir/quality.log" | head -1)

echo
echo "Results at ${tested:-an unknown commit}:"
echo
echo '| Job | Result | Detail |'
echo '|---|---|---|'
printf '%s\n' "${rows[@]}"
echo
echo 'Not run here: auth.spec.ts and the HTTP smoke test, which only CI runs.'
echo "Logs: $log_dir"
exit "$status"
