#!/usr/bin/env bash
# Fails when a migration line added between <base> and <head> adds a free-text column that may be null with no
# blank check: a `varchar(N)` or `text` column with no `notNull()`, no `IN (` list and no `btrim(...) <> ''`
# CHECK. A blank text is stored as none (CLAUDE.md, "PostgreSQL constraints … are part of the integrity
# boundary"; 0031, 0032), so the database refuses one, as `btrim(note) <> ''` does (#232 retro item 3).
#
# The column's options may run onto the next added lines, as `(col) =>` followed by `col.check(…)`: the
# check reads the line and the two after it. A column that keeps another rule, such as a snapshot of legacy
# text, is exempt by a comment on the line before it: `// text check: none — <why>`.
#
#   scripts/check-migration-text.sh <base> [<head>]      (head defaults to HEAD)
set -euo pipefail
base=${1:?usage: scripts/check-migration-text.sh <base> [<head>]}
head=${2:-HEAD}
cd "$(dirname "$0")/.."

column="addColumn\\('[a-z_]+', '(varchar\\([0-9]+\\)|text)'"
exemption='// text check: none — '
found=0

# Checks the added lines of one file, in order.
check_file() {
  local file=$1
  shift
  local lines=("$@") i span
  for ((i = 0; i < ${#lines[@]}; i++)); do
    [[ ${lines[i]} =~ $column ]] || continue
    span="${lines[i]} ${lines[i + 1]:-} ${lines[i + 2]:-}"
    [[ $span == *notNull* || $span == *"IN ("* || $span == *btrim* ]] && continue
    ((i > 0)) && [[ ${lines[i - 1]} == *"$exemption"?* ]] && continue
    echo "check-migration-text: $file: a free-text column that may be null has no btrim(...) <> '' CHECK, in: ${lines[i]:0:160}"
    found=1
  done
}

file=
added=()
while IFS= read -r line; do
  case $line in
    '+++ b/'*)
      [[ -z $file ]] || check_file "$file" "${added[@]}"
      file=${line#+++ b/}
      added=()
      ;;
    '+++ '*) ;;
    +*) added+=("${line:1}") ;;
  esac
done < <(git diff --no-color --unified=0 "$base...$head" -- 'packages/db/src/migrations/*.ts')
[[ -z $file ]] || check_file "$file" "${added[@]}"

if ((found)); then
  echo "check-migration-text: add the CHECK, or exempt the column with \"$exemption<why>\" on the line before it" >&2
  exit 1
fi
echo "check-migration-text: every free-text column added since $base that may be null refuses a blank text"
