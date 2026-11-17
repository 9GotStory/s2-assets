#!/usr/bin/env bash
# Fails when the web app names, in a fixed aria-labelledby="…", an id that no element in
# apps/web/src carries as a fixed id="…" (#155 retro: the Asset page's register correction had no name).
# A label or id built with {…} goes unseen.
#
#   scripts/check-aria-labels.sh
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
while IFS= read -r label; do
  grep -rqF --include='*.tsx' "id=\"$label\"" apps/web/src || { echo "check-aria-labels: aria-labelledby=\"$label\" names no id=\"$label\" in apps/web/src" >&2; status=1; }
done < <(grep -rhoE --include='*.tsx' 'aria-labelledby="[^"]+"' apps/web/src | sed -E 's/.*="([^"]+)"/\1/' | tr ' ' '\n' | sort -u)
((status == 0)) && echo "check-aria-labels: every fixed aria-labelledby names an id in apps/web/src"
exit "$status"
