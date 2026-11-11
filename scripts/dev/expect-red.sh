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
# <old text> must occur exactly once in <file> and is replaced as literal text, not a pattern. The file
# is restored however the run ends, Ctrl-C included. Exits 0 when the test command fails (red) and 1
# when it passes (the test did not notice the break); 2 for a usage error.
set -euo pipefail
cd "$(dirname "$0")/../.."

note() { echo "${0##*/}: $*" >&2; }

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
