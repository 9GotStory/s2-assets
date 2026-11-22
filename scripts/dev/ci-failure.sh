#!/usr/bin/env bash
# Shows why a CI run failed, in one call: each failed job, the failing tests with their errors, and for each
# Playwright trace the API requests with their session and CSRF values cut to 6 characters (#203 retro).
#
#   scripts/dev/ci-failure.sh <run id> [<attempt>]
#
# The run's playwright-results artifact is kept in ~/.cache/s2-assets-ci-failures/<head>-<run>-<attempt>,
# apart from scripts/ci/e2e.sh's local failures, which it rotates.
# Exits 0 when it printed a failed run, 1 when the run did not fail, 2 for a usage error.
set -euo pipefail

REPO=9GotStory/s2-assets
KEPT=${XDG_CACHE_HOME:-$HOME/.cache}/s2-assets-ci-failures
# Lines of the failed jobs' log worth reading: Playwright's failures and errors, Vitest's FAIL and ×.
FAILURE_LINES='✘|^ +[0-9]+\) \[|Error:|Expected|Received|^ +> +[0-9]+ \||(^| )FAIL |(^| )× '

note() { echo "${0##*/}: $*" >&2; }

[[ ${1:-} =~ ^[0-9]+$ && ${2:-1} =~ ^[0-9]+$ ]] || { note 'usage: ci-failure.sh <run id> [<attempt>]'; exit 2; }
run=$1
attempt=${2:-$(gh run view "$run" --repo "$REPO" --json attempt --jq .attempt)}

conclusion=$(gh run view "$run" --repo "$REPO" --attempt "$attempt" --json conclusion --jq .conclusion)
if [[ $conclusion != failure ]]; then
  note "run $run attempt $attempt: $conclusion"
  exit 1
fi
gh run view "$run" --repo "$REPO" --attempt "$attempt" --json jobs \
  --jq '.jobs[] | select(.conclusion == "failure") | "failed job: \(.name)"'

# Each log line is "<job>\t<step>\t<timestamp> <text>": keep the text.
gh run view "$run" --repo "$REPO" --attempt "$attempt" --log-failed \
  | cut -f3- | cut -d' ' -f2- | grep -E "$FAILURE_LINES" | head -n 80 || true

head=$(gh run view "$run" --repo "$REPO" --json headSha --jq '.headSha[0:7]')
dir="$KEPT/$head-$run-$attempt"
if [[ ! -d $dir ]]; then
  mkdir -p "$dir"
  gh run download "$run" --repo "$REPO" --name playwright-results -D "$dir/playwright-results" 2>/dev/null \
    || { note "run $run has no playwright-results artifact"; rmdir "$dir"; exit 0; }
fi
note "artifact kept in $dir"

find "$dir/playwright-results" -name trace.zip -print0 | while IFS= read -r -d '' trace; do
  unpacked="${trace%.zip}"
  [[ -d $unpacked ]] || unzip -oq "$trace" -d "$unpacked"
  echo "== ${trace#"$dir/playwright-results/"}"
  python3 -I - "$unpacked" <<'EOF'
import glob, json, re, sys
from urllib.parse import urlsplit

cut = lambda value: re.sub(r'=([^;=\s]{6})[^;\s]*', r'=\1…', value)
entries = []
for network in glob.glob(sys.argv[1] + '/*.network'):
    for line in open(network):
        snapshot = json.loads(line).get('snapshot', {})
        request, response = snapshot.get('request', {}), snapshot.get('response', {})
        path = urlsplit(request.get('url', '')).path
        # The page's API requests: no file extension and none of the dev server's own paths.
        if '.' in path.rsplit('/', 1)[-1] or path.startswith(('/@', '/node_modules', '/src/')):
            continue
        sent = [f"cookie: {cut(h['value'])}" for h in request.get('headers', []) if h['name'].lower() == 'cookie']
        sent += [f"x-csrf-token: {h['value'][:6]}…" for h in request.get('headers', []) if h['name'].lower() == 'x-csrf-token']
        got = [f"set-cookie: {cut(h['value']).split(';')[0]}" for h in response.get('headers', [])
               if h['name'].lower() == 'set-cookie']
        entries.append((snapshot.get('startedDateTime', ''), request.get('method'), path, response.get('status'), sent, got))
for started, method, path, status, sent, got in sorted(entries):
    print(f"{started[11:23]} {method} {path} {status if status != -1 else '(no response recorded)'}")
    for header in sent + got:
        print(f"    {header}")
EOF
done
