#!/usr/bin/env bash
# Says how much memory the host has available as a long run starts, and warns under 4 GiB. In #237,
# with about 3 GiB left beside a qemu VM and a browser, Claude Code's low-memory reaper stopped an
# expect-red batch left in the background at break 173 of 220. Free the memory first, or run the work
# in foreground parts (expect-red.sh --batch <breaks.json> --part <k>/<n>).
#
#   scripts/dev/memory-note.sh <name of the calling script>
#
# Always exits 0: the note informs, and the run goes on.
set -uo pipefail
caller=$1
kib=$(LC_ALL=C awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
echo "$caller: MemAvailable $(LC_ALL=C awk -v kib="$kib" 'BEGIN { printf "%.1f", kib / 1048576 }') GiB" >&2
if ((kib < 4 * 1048576)); then
  echo "$caller: WARNING: under 4 GiB available, so a long run may be stopped for memory: free some first, or run it in parts" >&2
fi
exit 0
