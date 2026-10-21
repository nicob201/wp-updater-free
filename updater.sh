#!/bin/bash
# Updates WordPress core, plugins, themes and translations over SSH + WP-CLI.
# Usage: ./updater.sh                        (only shows what's pending, touches nothing)
#        ./updater.sh --apply                (backs up each site's database and updates them all)
#        ./updater.sh --apply example.com    (only that one)
#        ./updater.sh --json [domain…]       (pending updates as JSON, for the page)
#        ./updater.sh --probe                (exits 0 if the SSH connection works)
set -eo pipefail
cd "$(dirname "$0")"

HOST="wp"                             # alias defined in ~/.ssh/config
EXCLUDE="elementor,elementor-pro"     # updated by hand, together
BACKUPS="data/backups"
MODE=""
case "$1" in --apply|--json|--probe) MODE=${1#--}; shift ;; esac
[ "$MODE" = probe ] && exec ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true >/dev/null 2>&1
SITES=("$@")
# For the page: never ask for a password (nobody is there to type it) and never hang if the network drops
OPTS=()
[ "$MODE" = json ] && OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
# No domains given: every WordPress in the account
[ ${#SITES[@]} -gt 0 ] || SITES=($(ssh "${OPTS[@]}" "$HOST" 'ls domains/*/public_html/wp-config.php' | cut -d/ -f2))
[ "$MODE" = json ] && echo "{\"sites\":[$(printf '"%s",' "${SITES[@]}" | sed 's/,$//')]}"
FAILED=()
N=0

for SITE in "${SITES[@]}"; do
  REMOTE="domains/$SITE/public_html"
  N=$((N+1))
  echo "===== [$N/${#SITES[@]}] $SITE"

  if [ "$MODE" = json ]; then
    # One JSON line per site; if the site fails, a line with "error" and on to the next one
    ssh "${OPTS[@]}" "$HOST" "bash -s" <<EOF || echo "{\"site\":\"$SITE\",\"error\":\"could not list (no connection or not a WordPress)\"}"
set -eo pipefail
cd $REMOTE
wp transient delete update_plugins --network --quiet || true
wp transient delete update_themes --network --quiet || true
WP=\$(wp core version)
C=\$(wp core check-update --force-check --format=json)
P=\$(wp plugin list --update=available --fields=name,status,version,update_version --format=json)
T=\$(wp theme list --update=available --fields=name,status,version,update_version --format=json)
echo "{\"site\":\"$SITE\",\"wp\":\"\$WP\",\"exclude\":[\"${EXCLUDE//,/\",\"}\"],\"core\":\${C:-[]},\"plugins\":\${P:-[]},\"themes\":\${T:-[]}}"
EOF
    continue
  fi

  if [ -z "$MODE" ]; then
    # Clears the update list WordPress keeps in cache: otherwise it can show a stale one
    ssh "$HOST" "cd $REMOTE && wp transient delete update_plugins --network --quiet; wp transient delete update_themes --network --quiet; \
      wp core check-update --force-check \
      && wp plugin list --update=available --fields=name,status,version,update_version \
      && wp theme list --update=available --fields=name,status,version,update_version"
    echo "(left alone: $EXCLUDE)"
    continue
  fi

  DIR="$BACKUPS/$SITE"
  mkdir -p "$DIR"
  echo "== $SITE: database backup"
  # wp db export doesn't work on Hostinger: it disables proc_open(). mysqldump is called directly.
  ssh "$HOST" "bash -s" > "$DIR/database.sql.gz.tmp" <<EOF || { echo "== $SITE: database backup failed, not updated"; FAILED+=("$SITE (backup)"); continue; }
set -eo pipefail
cd $REMOTE
DB_NAME="\$(wp config get DB_NAME)"
DB_USER="\$(wp config get DB_USER)"
DB_HOST="\$(wp config get DB_HOST)"
export MYSQL_PWD="\$(wp config get DB_PASSWORD)"
mysqldump --single-transaction --no-tablespaces --default-character-set=utf8mb4 \
  -h "\$DB_HOST" -u "\$DB_USER" "\$DB_NAME" | gzip
EOF
  gzip -dc "$DIR/database.sql.gz.tmp" | tail -1 | grep -q "Dump completed" \
    || { echo "== $SITE: database backup incomplete, not updated"; FAILED+=("$SITE (backup)"); continue; }
  # Only the latest one is kept: the previous one is replaced only now that the new one is verified
  mv "$DIR/database.sql.gz.tmp" "$DIR/database.sql.gz"
  # To roll a plugin back: wp plugin install <name> --version=<the one in this file> --force
  ssh "$HOST" "cd $REMOTE && wp plugin list --fields=name,status,version && wp theme list --fields=name,status,version" \
    > "$DIR/versions-before.txt"

  echo "== $SITE: updating"
  ssh "$HOST" "bash -s" <<EOF || { echo "== $SITE: update failed"; FAILED+=("$SITE (update)"); }
set -eo pipefail
cd $REMOTE
wp core update
wp core update-db
wp plugin update --all --exclude=$EXCLUDE
wp theme update --all
wp language core update
wp language plugin update --all
wp language theme update --all
wp cache flush || true
wp litespeed-purge all || true
EOF

  CODE=$(curl -sL -o /dev/null -w '%{http_code}' "https://$SITE") || true
  if [ "$CODE" = 200 ]; then echo "== $SITE: OK"; else echo "== $SITE: site responds $CODE, check it"; FAILED+=("$SITE (site $CODE)"); fi
done

[ ${#FAILED[@]} -eq 0 ] || { echo; echo "Check: ${FAILED[*]}"; exit 1; }
