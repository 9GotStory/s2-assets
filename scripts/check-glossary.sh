#!/usr/bin/env bash
# Fails when a line added to the application source uses a term that GLOSSARY.md avoids, such as a
# name like "ReferenceContext" or a label like "โอนย้าย". Only lines added between <base> and <head>
# are checked, and a name or path that already exists at <base> stays usable.
#
#   scripts/check-glossary.sh <base> [<head>]      (head defaults to HEAD; CI passes HEAD^1)
set -euo pipefail
base=${1:?usage: scripts/check-glossary.sh <base> [<head>]}
head=${2:-HEAD}
cd "$(dirname "$0")/.."

SOURCE=(':(glob)apps/*/src/**' ':(glob)packages/*/src/**')

# Avoided terms that are also everyday words in code, or preferred terms elsewhere in the
# glossary. A review judges these. "โอน" is part of the acquisition method "รับโอน".
GENERIC='^(edit|delete|reassignment|error|invalid event|owner|ownership|user|ผู้ใช้งาน|custodian|created at|responsible person|ผู้รับผิดชอบ|โอน)$'

terms=()
while IFS= read -r term; do
  term=$(sed -E 's/\(.*\)//; s/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$term")
  [[ -n $term ]] || continue
  grep -qiE "$GENERIC" <<<"$term" && continue
  terms+=("$(sed -E 's/[[:space:]]+/[ _-]?/g' <<<"$term")")
done < <(sed -n 's/^_Avoid_: //p' GLOSSARY.md | tr ',' '\n')
((${#terms[@]})) || { echo "check-glossary: no _Avoid_ terms found in GLOSSARY.md" >&2; exit 1; }
token="[A-Za-z0-9_./-]*($(IFS='|'; echo "${terms[*]}"))[A-Za-z0-9_]*"

base_paths=$(git ls-tree -r --name-only "$base")
exists_at_base() {
  git grep -qF -e "$1" "$base" -- "${SOURCE[@]}" || grep -qF -- "$1" <<<"$base_paths"
}

found=0
file=
while IFS= read -r line; do
  case $line in
    '+++ b/'*) file=${line#+++ b/}; continue ;;
    '+++ '*) continue ;;
    +*) ;;
    *) continue ;;
  esac
  while IFS= read -r hit; do
    [[ -n $hit ]] || continue
    # A phrase with a space is prose, checked every time; a name may already exist.
    if [[ $hit != *' '* ]] && exists_at_base "$hit"; then
      continue
    fi
    echo "check-glossary: $file: \"$hit\" in: ${line:1:160}"
    found=1
  done < <(grep -oiE -- "$token" <<<"${line:1}" || true)
done < <(git diff --no-color --unified=0 "$base...$head" -- "${SOURCE[@]}")

if ((found)); then
  echo "check-glossary: use the GLOSSARY.md term instead; a name that exists at $base stays usable." >&2
  exit 1
fi
echo "check-glossary: no avoided term added since $base"
