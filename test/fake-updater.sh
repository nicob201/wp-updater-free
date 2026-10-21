#!/bin/bash
# Imitates updater.sh's output to test the page without touching real sites.
# Reads WPU_SERVER, WPU_SKIP, WPU_EXCLUDE and WPU_FULL_BACKUP like the real one. Test knobs:
# FAKE_SLOW: seconds between lines (0.2). FAKE_SSH=bad: no connection (like the real one: nothing, exits 255).
# FAKE_CUT=1: --apply dies in the middle of a line, as if it were killed. FAKE_DUP=1: site c shares a's database.
L=${FAKE_SLOW:-0.2}
S=${WPU_SERVER:-aaaaaaaa}
EXCLUDE=${WPU_EXCLUDE-elementor,elementor-pro}
item() { echo "{\"name\":\"$1\",\"status\":\"active\",\"version\":\"$2\",\"update_version\":\"$3\"}"; }
case "$1" in
  --probe) [ "$FAKE_SSH" = bad ] && { echo "Can't connect over SSH. Check the host, port and user."; exit 1; }; echo OK ;;
  --json)
    [ "$FAKE_SSH" = bad ] && exit 255
    SKIPPED=(); TODO=()
    for p in a b c; do
      if [[ ":$WPU_SKIP:" == *":/sites/$p:"* ]]; then SKIPPED+=("\"/sites/$p\""); else TODO+=("$p"); fi
    done
    echo "{\"server\":\"$S\",\"sites\":[\"/sites/a\",\"/sites/b\",\"/sites/c\"],\"skipped\":[$(IFS=,; echo "${SKIPPED[*]}")]}"
    echo 'PHP: test notice' >&2
    N=0
    for p in "${TODO[@]}"; do
      N=$((N+1))
      case $p in
        a) PLUGINS="$(item woocommerce 11.2.0 11.2.1),$(item elementor-pro 4.0.1 4.3.2)"; THEMES=$(item astra 4.14.0 4.14.1) ;;
        b) PLUGINS=$(item elementor-pro 4.0.1 4.3.2); THEMES= ;;
        c) PLUGINS=$(item hostinger 3.0.76 3.0.80); THEMES= ;;
      esac
      DB=$p; [ "$p" = c ] && [ -n "$FAKE_DUP" ] && DB=a
      sleep "$L"; echo "===== [$N/${#TODO[@]}] $S:/sites/$p"
      sleep "$L"; echo "{\"site\":\"$S:/sites/$p\",\"url\":\"https://$p.$S.test\",\"db\":{\"name\":\"db_${DB}_$S\",\"host\":\"localhost\",\"prefix\":\"wp_\"},\"wp\":\"7.1.3\",\"exclude\":[$( [ -n "$EXCLUDE" ] && echo "\"${EXCLUDE//,/\",\"}\"")],\"core\":[],\"plugins\":[$PLUGINS],\"themes\":[$THEMES]}"
    done
    ;;
  --apply)
    shift; N=0
    id() { case $1 in /*) echo "$S:$1" ;; *) echo "$1" ;; esac; }   # takes site paths like the real one, or full ids
    if [ -n "$FAKE_CUT" ]; then
      d=$(id "$1"); echo "===== [1/$#] $d"; echo "== $d: database backup"; printf 'Downloading upd'; exit 1
    fi
    for a in "$@"; do
      N=$((N+1)); d=$(id "$a")
      STEPS=("===== [$N/$#] $d" "== $d: database backup")
      [ "$WPU_FULL_BACKUP" = 1 ] && STEPS+=("== $d: copying files")
      STEPS+=("== $d: updating" "Downloading update from https://downloads.wordpress.org/plugin/woocommerce.11.2.1.zip..."
              "$(printf 'woocommerce\t11.2.0\t11.2.1\tUpdated')" "== $d: OK")
      for l in "${STEPS[@]}"; do echo "$l"; sleep "$L"; done
    done ;;
esac
