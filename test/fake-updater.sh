#!/bin/bash
# Imitates updater.sh's output to test the page without touching real sites.
# FAKE_SLOW: seconds between lines (0.2). FAKE_SSH=bad: no connection (like the real one: nothing, exits 255).
# FAKE_CUT=1: --apply dies in the middle of a line, as if it were killed.
L=${FAKE_SLOW:-0.2}
case "$1" in
  --probe) [ "$FAKE_SSH" = bad ] && exit 255; exit 0 ;;
  --json)
    [ "$FAKE_SSH" = bad ] && exit 255
    echo '{"sites":["a.test","b.test","c.test"]}'
    sleep "$L"; echo '===== [1/3] a.test'
    echo 'PHP: test notice' >&2
    sleep "$L"; echo '{"site":"a.test","wp":"7.1.3","exclude":["elementor","elementor-pro"],"core":[],"plugins":[{"name":"woocommerce","status":"active","version":"11.2.0","update_version":"11.2.1"},{"name":"elementor-pro","status":"active","version":"4.0.1","update_version":"4.3.2"}],"themes":[{"name":"astra","status":"active","version":"4.14.0","update_version":"4.14.1"}]}'
    sleep "$L"; echo '===== [2/3] b.test'
    sleep "$L"; echo '{"site":"b.test","wp":"7.1.3","exclude":["elementor","elementor-pro"],"core":[],"plugins":[{"name":"elementor-pro","status":"active","version":"4.0.1","update_version":"4.3.2"}],"themes":[]}'
    sleep "$L"; echo '===== [3/3] c.test'
    sleep "$L"; echo '{"site":"c.test","wp":"7.1.3","exclude":["elementor","elementor-pro"],"core":[],"plugins":[{"name":"hostinger","status":"active","version":"3.0.76","update_version":"3.0.80"}],"themes":[]}'
    ;;
  --apply)
    shift; N=0
    if [ -n "$FAKE_CUT" ]; then
      echo "===== [1/$#] $1"; echo "== $1: database backup"; printf 'Downloading upd'; exit 1
    fi
    for d in "$@"; do
      N=$((N+1))
      for l in "===== [$N/$#] $d" "== $d: database backup" "== $d: updating" \
               "Downloading update from https://downloads.wordpress.org/plugin/woocommerce.11.2.1.zip..." \
               "$(printf 'woocommerce\t11.2.0\t11.2.1\tUpdated')" "== $d: OK"; do
        echo "$l"; sleep "$L"
      done
    done ;;
esac
