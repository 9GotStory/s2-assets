#!/usr/bin/env bash
# Breaks code on purpose and checks that a test goes red, then puts the code back. CLAUDE.md: a test
# first seen green is not done until breaking the code it covers turns it red.
#
#   scripts/dev/expect-red.sh <file> <old text> <new text> -- <test command...>
#
# for example:
#   scripts/dev/expect-red.sh apps/api/src/routes/loan.routes.ts "'must not be blank'" "'blank'" \
#     -- scripts/ci/integration.sh tests/integration/loan-list.test.ts -t "refuse a value"
#
# Check that the red names the test you broke the code for. Run a file whose tests share state, such as
# a Seam C migration file, whole: a -t filter skips the test that sets the state up, and the rest go red
# for that alone.
#
# <old text> must occur exactly once in <file> and is replaced as literal text, not a pattern. The file
# is restored however the run ends, Ctrl-C included. Exits 0 when the test command fails (red) and 1
# when it passes (the test did not notice the break); 2 for a usage error.
#
#   scripts/dev/expect-red.sh --batch <breaks.json>
#
# runs several breaks in turn, each as above, and ends with a table of RED or STAYED GREEN and the first
# failing test. <breaks.json> is an array of {"name", "file", "old", "new", "test": [command, args...]};
# write a line break inside old or new as \n. Exits 0 when every break is red, 1 when one stayed green,
# and 2 when one could not be applied.
set -euo pipefail
cd "$(dirname "$0")/../.."

note() { echo "${0##*/}: $*" >&2; }

if [[ ${1-} == --batch ]]; then
  if (($# != 2)) || [[ ! -f $2 ]]; then
    note 'usage: expect-red.sh --batch <breaks.json>'
    exit 2
  fi
  exec python3 -I - "$0" "$2" <<'EOF'
import json, re, subprocess, sys
script, batch = sys.argv[1:]
breaks = json.load(open(batch, encoding='utf-8'))
rows, worst = [], 0
for b in breaks:
    print(f"expect-red.sh: {b['name']}: breaking {b['file']}", file=sys.stderr, flush=True)
    run = subprocess.run([script, b['file'], b['old'], b['new'], '--', *b['test']], capture_output=True, text=True)
    out = run.stdout + run.stderr
    # The first failing test, as Vitest (×) or Playwright (✘) names it; pnpm's own failure line is not one.
    failed = [m.group(1).strip() for m in re.finditer(r'^\s*[×✘]\s+(.*)$', out, re.M) if 'pnpm recursive exec' not in m.group(1)]
    result = {0: 'RED', 1: 'STAYED GREEN'}.get(run.returncode, 'ERROR')
    worst = max(worst, {'RED': 0, 'STAYED GREEN': 1, 'ERROR': 2}[result])
    # Otherwise this script's own last note says why: the test passed, or the break could not be applied.
    notes = [line for line in out.splitlines() if line.startswith('expect-red.sh:')] or out.strip().splitlines()[-1:]
    detail = (failed[0] if result == 'RED' and failed else notes[-1] if notes else '')[:160]
    print(f"expect-red.sh: {b['name']}: {result}", file=sys.stderr, flush=True)
    rows.append(f"| {b['name']} | {result} | {detail.replace('|', '¦')} |")
print('| Break | Result | First failing test, or the last output |')
print('|---|---|---|')
print('\n'.join(rows))
sys.exit(worst)
EOF
fi

if (($# < 5)) || [[ $4 != -- ]]; then
  note 'usage: expect-red.sh <file> <old text> <new text> -- <test command...>'
  exit 2
fi
file=$1 old=$2 new=$3
shift 4
[[ -f $file ]] || { note "no such file: $file"; exit 2; }

backup=$(mktemp)
trap 'cp -- "$backup" "$file"; rm -f -- "$backup"' EXIT
cp -- "$file" "$backup"

python3 -I - "$file" "$old" "$new" <<'EOF' || exit 2
import sys
path, old, new = sys.argv[1:]
text = open(path, encoding='utf-8').read()
count = text.count(old)
if count != 1:
    sys.exit(f'expect-red.sh: the old text occurs {count} times in {path}, not once')
open(path, 'w', encoding='utf-8').write(text.replace(old, new))
EOF

note "broke $file; running: $*"
if "$@"; then
  note "GREEN: the test command passed with $file broken, so it does not cover this change"
  exit 1
fi
note "RED: the test command failed with $file broken; $file is restored"
