#!/usr/bin/env bash
# Runs every job that CI Gate requires, in its order, locally, and reports them for a pull request's
# Evidence.
#
#   scripts/ci/all.sh [--base <rev>] [--log-dir <dir>]
#
#   --base <rev>     passed to quality.sh, for `git diff --check` and the glossary check against <rev>.
#   --log-dir <dir>  where each job's log goes (default: a new temporary directory).
#
# Every job runs, so one failure does not hide another. The output ends with a Markdown table of the
# results, and the exit status is non-zero when any job failed. Each job takes the host's job lock
# itself (common.sh), so this script sources nothing from there: holding the lock here would leave
# the first job waiting for it.
set -euo pipefail
cd "$(dirname "$0")/../.."

base=
log_dir=
while (($#)); do
  case $1 in
    --base) base=${2:?--base needs a revision}; shift 2 ;;
    --log-dir) log_dir=${2:?--log-dir needs a directory}; shift 2 ;;
    *) echo "all.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
log_dir=${log_dir:-$(mktemp -d -t s2-assets-ci.XXXXXX)}
mkdir -p "$log_dir"

head=$(git rev-parse --short HEAD)
tree=$([[ -z $(git status --porcelain) ]] && echo clean || echo dirty)

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
run_job security 'no HIGH or CRITICAL finding' scripts/ci/security-scan.sh

echo
echo "Results at \`$head\`, tree $tree:"
echo
echo '| Job | Result | Detail |'
echo '|---|---|---|'
printf '%s\n' "${rows[@]}"
echo
echo "Logs: $log_dir"
exit "$status"
