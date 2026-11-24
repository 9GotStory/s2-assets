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
# A condition joined by && or || takes a break per operand: drop each one in turn, since a break of the whole
# condition leaves an operand no test needs (F008-T6, #182).
#
# A void that cascades is filtered twice: a Loan void marks each LoanItem voided, and a Repair Record void
# its Outcome. A break that removes one of the two filters stays green, so remove both (F007-T6, #160).
#
# Check that the red names the test you broke the code for. Run a file whose tests share state, such as
# a Seam C migration file, whole: a -t filter skips the test that sets the state up, and the rest go red
# for that alone.
#
# <old text> must occur exactly once in <file> and is replaced as literal text, not a pattern. The file
# is restored however the run ends, Ctrl-C included. Exits 0 when the test command fails (red) and 1
# when it passes (the test did not notice the break); 2 for a usage error.
#
# A break that takes several edits, such as moving a read ahead of a lock and using its result later,
# gives one <file> <old text> <new text> triple per edit before the --. They apply in order, each to the
# file as the earlier ones left it, and every file named is restored.
#
#   scripts/dev/expect-red.sh --batch <breaks.json>
#
# runs several breaks in turn, each as above, and ends with a table of RED or STAYED GREEN and the first
# failing test. <breaks.json> is an array of {"name", "file", "old", "new", "test": [command, args...]},
# or of {"name", "edits": [{"file", "old", "new"}, ...], "test"} for a break of several edits; write a
# line break inside old or new as \n. Exits 0 when every break is red, 1 when one stayed green,
# and 2 when one could not be applied.
#
# A break that must turn several tests red, such as a read moved ahead of a lock that three order tests
# cover, lists them in "red": [<part of each test's name>, ...]. The break is red only when every one of
# them fails, and the table names each that passed as STAYED GREEN: the table shows one failing test,
# so the others went unseen and were rerun one by one with -t (F009-T3 retro, #205).
#
# A web break may skip the journeys after the one it breaks: Playwright takes the rest of e2e.sh's
# arguments, as in "test": ["scripts/ci/e2e.sh", "tests/e2e/<spec>", "-g", "<pattern>"]. Each spec is a
# test.describe.serial whose later journeys build on what earlier ones left, so the pattern also matches
# every journey before the broken one: alone, Journey F009-T2.1 fails for want of T1.1's "กระดาษ A4"
# (F009-T2 retro, #204).
#
#   scripts/dev/expect-red.sh --uncovered <base> <breaks.json>
#
# lists each line the change adds to source under apps/*/src or packages/*/src since <base> (the working
# tree included) that holds a branch (if, throw, &&, ||, ??, or a ? : choice), when no break in
# <breaks.json> edits it: a break covers a line when a line of its old text, at least 8 characters, is
# part of it, or it is part of that line; a throw right under a covered if goes with it. Run it before --batch, and give each line it lists a break or
# a reason it has none. It also lists each break whose old text, its edits applied in order, does not occur
# exactly once, which --batch would answer with ERROR. Exits 0 when every such line is covered and every old text
# occurs once, and 1 otherwise. In F009-T2 (#204) a plan
# of 83 breaks missed the Brand, the Model, a blank search and the loading line of a picker, and only
# review found them.
set -euo pipefail
cd "$(dirname "$0")/../.."

note() { echo "${0##*/}: $*" >&2; }

if [[ ${1-} == --uncovered ]]; then
  if (($# != 3)) || [[ ! -f $3 ]] || ! git rev-parse --verify --quiet "$2^{commit}" >/dev/null; then
    note 'usage: expect-red.sh --uncovered <base> <breaks.json>'
    exit 2
  fi
  exec python3 -I - "$2" "$3" <<'EOF'
import json, re, subprocess, sys
base, batch = sys.argv[1:]
diff = subprocess.run(['git', 'diff', '--unified=0', '--no-color', base, '--', 'apps/*/src/*', 'packages/*/src/*'], capture_output=True, text=True, check=True).stdout
breaks = json.load(open(batch, encoding='utf-8'))
olds = {}
for b in breaks:
    for e in b.get('edits') or [{'file': b['file'], 'old': b['old']}]:
        olds.setdefault(e['file'], []).extend(part.strip() for part in e['old'].split('\n') if len(part.strip()) >= 8)
# A branch: if, throw, && or ||, ??, or the ? of a ? : choice (not ?. or an optional `name?:`).
BRANCH = re.compile(r'\bif \(|\bthrow\b|&&|\|\||\?\?|\s\?\s')
COMMENT = re.compile(r'^\s*(//|/?\*|\{/\*)')
path, line, uncovered = None, 0, []
# A throw right under an if whose break is in the file goes with that if.
after_covered_if = False
for raw in diff.splitlines():
    if raw.startswith('+++ '):
        path = raw[6:] if raw.startswith('+++ b/') else None
    elif raw.startswith('@@'):
        line = int(re.match(r'@@ -\S+ \+(\d+)', raw).group(1))
        after_covered_if = False
    elif raw.startswith('+') and path:
        stripped = raw[1:].strip()
        covered = any(part in stripped or stripped in part for part in olds.get(path, []))
        if BRANCH.search(stripped) and not COMMENT.match(stripped):
            if not covered and not (after_covered_if and stripped.startswith('throw')):
                uncovered.append(f'{path}:{line}: {stripped[:140]}')
        after_covered_if = covered and stripped.startswith('if (')
        line += 1
# Each break's old text occurs exactly once, its edits applied in order as --batch applies them, so that no break of
# the batch ends in ERROR (#210 retro).
misplaced = []
for b in breaks:
    texts = {}
    for i, e in enumerate(b.get('edits') or [{'file': b['file'], 'old': b['old'], 'new': b['new']}], 1):
        if e['file'] not in texts:
            try:
                texts[e['file']] = open(e['file'], encoding='utf-8').read()
            except FileNotFoundError:
                misplaced.append(f"{b['name']}: {e['file']} does not exist")
                break
        count = texts[e['file']].count(e['old'])
        if count != 1:
            misplaced.append(f"{b['name']}: the old text of edit {i} occurs {count} times in {e['file']}, not once")
            break
        texts[e['file']] = texts[e['file']].replace(e['old'], e['new'])
print('\n'.join(uncovered + misplaced) if uncovered or misplaced else 'expect-red.sh: every added branch line has a break, and every old text occurs once')
sys.exit(1 if uncovered or misplaced else 0)
EOF
fi

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
    edits = b.get('edits') or [{'file': b['file'], 'old': b['old'], 'new': b['new']}]
    files = ', '.join(dict.fromkeys(e['file'] for e in edits))
    print(f"expect-red.sh: {b['name']}: breaking {files}", file=sys.stderr, flush=True)
    triples = [arg for e in edits for arg in (e['file'], e['old'], e['new'])]
    run = subprocess.run([script, *triples, '--', *b['test']], capture_output=True, text=True)
    # Colour codes would hide the × or ✘ at the start of a line (F008-T2 retro, #177).
    out = re.sub(r'\x1b\[[0-9;]*m', '', run.stdout + run.stderr)
    # The first failing test, as Vitest (×) or Playwright (✘) names it; pnpm's own failure line is not one.
    failed = [m.group(1).strip() for m in re.finditer(r'^\s*[×✘]\s+(.*)$', out, re.M) if 'pnpm recursive exec' not in m.group(1)]
    result = {0: 'RED', 1: 'STAYED GREEN'}.get(run.returncode, 'ERROR')
    # Each test the break names must be among the failures, not only the first.
    passed = [name for name in b.get('red', []) if not any(name in test for test in failed)] if result == 'RED' else []
    if passed:
        result = 'STAYED GREEN'
    worst = max(worst, {'RED': 0, 'STAYED GREEN': 1, 'ERROR': 2}[result])
    # Otherwise this script's own last note says why: the test passed, or the break could not be applied.
    notes = [line for line in out.splitlines() if line.startswith('expect-red.sh:')] or out.strip().splitlines()[-1:]
    detail = (failed[0] if result == 'RED' and failed else '; '.join(f'STAYED GREEN: {name}' for name in passed) if passed else notes[-1] if notes else '')[:160]
    print(f"expect-red.sh: {b['name']}: {result}", file=sys.stderr, flush=True)
    rows.append(f"| {b['name']} | {result} | {detail.replace('|', '¦')} |")
print('| Break | Result | First failing test, or the last output |')
print('|---|---|---|')
print('\n'.join(rows))
sys.exit(worst)
EOF
fi

usage() {
  note 'usage: expect-red.sh <file> <old text> <new text> [<file> <old text> <new text>...] -- <test command...>'
  exit 2
}
edits=()
while (($#)) && [[ $1 != -- ]]; do
  (($# >= 3)) || usage
  [[ -f $1 ]] || { note "no such file: $1"; exit 2; }
  edits+=("$1" "$2" "$3")
  shift 3
done
((${#edits[@]})) && (($# >= 2)) || usage
shift

# One backup per file named, restored however the run ends.
backups=$(mktemp -d)
files=()
restore() {
  local i
  for i in "${!files[@]}"; do
    cp -- "$backups/$i" "${files[$i]}"
  done
  rm -rf -- "$backups"
}
trap restore EXIT
for ((i = 0; i < ${#edits[@]}; i += 3)); do
  file=${edits[i]}
  if [[ " ${files[*]-} " != *" $file "* ]]; then
    cp -- "$file" "$backups/${#files[@]}"
    files+=("$file")
  fi
done

python3 -I - "${edits[@]}" <<'EOF' || exit 2
import sys
args = sys.argv[1:]
for i in range(0, len(args), 3):
    path, old, new = args[i:i + 3]
    text = open(path, encoding='utf-8').read()
    count = text.count(old)
    if count != 1:
        sys.exit(f'expect-red.sh: the old text of edit {i // 3 + 1} occurs {count} times in {path}, not once')
    open(path, 'w', encoding='utf-8').write(text.replace(old, new))
EOF

broken=${files[*]}
note "broke $broken; running: $*"
if "$@"; then
  note "GREEN: the test command passed with $broken broken, so it does not cover this change"
  exit 1
fi
note "RED: the test command failed with $broken broken; $broken restored"
