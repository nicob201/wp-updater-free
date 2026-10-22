#!/bin/bash
# Lists and applies WordPress updates (core, plugins, themes, translations) on one server over SSH + WP-CLI.
# The bridge (server.js) passes the connection in WPU_* variables.
# Usage: updater.sh --probe           checks the connection and the server's tools: prints OK (plus no-rsync) or why not
#        updater.sh --json            finds the WordPress sites and prints what's pending as JSON lines
#        updater.sh --sizes <path>…   measures how much a full copy of each site takes: one JSON line each
#        updater.sh --apply <path>…   backs up each site and updates it
set -eo pipefail
cd "$(dirname "$0")"

for V in WPU_SERVER WPU_HOST WPU_USER WPU_KEY; do
  [ -n "${!V}" ] || { echo "updater.sh: $V is not set" >&2; exit 2; }
done
WPU_PORT=${WPU_PORT:-22}
WPU_KNOWN_HOSTS=${WPU_KNOWN_HOSTS:-$(dirname "$WPU_KEY")/known_hosts}
WPU_BACKUPS=${WPU_BACKUPS:-data/backups}
MODE=$1; shift || true

# Never ask for a password (nobody is there to type it) and never hang if the network drops
SSH_OPTS=(-i "$WPU_KEY" -p "$WPU_PORT" -o IdentitiesOnly=yes -o "UserKnownHostsFile=$WPU_KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new
          -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
DEST="$WPU_USER@$WPU_HOST"
remote() { ssh "${SSH_OPTS[@]}" "$DEST" "$@"; }
# Files written by WP-CLI as root end up owned by root and break the site: every remote script starts with this
GUARD='[ "$(id -u)" != 0 ] || { echo "refusing to run as root" >&2; exit 1; }'
RE_PATH='^/[A-Za-z0-9._/~-]+$'
json_list() { local out=""; for X in "$@"; do out+="\"$X\","; done; echo "[${out%,}]"; }

if [ "$MODE" = --probe ]; then
  ERR=$(mktemp); trap 'rm -f "$ERR"' EXIT
  if ! OUT=$(remote 'echo "uid=$(id -u)"; command -v wp >/dev/null && echo has-wp; { command -v mysqldump || command -v mariadb-dump; } >/dev/null && echo has-dump; command -v rsync >/dev/null && echo has-rsync; true' </dev/null 2>"$ERR"); then
    if grep -q 'REMOTE HOST IDENTIFICATION HAS CHANGED' "$ERR"; then
      echo "The server's host key has changed. If you rebuilt or reinstalled the server, remove its old key (see README) and try again."
    elif grep -q 'Permission denied' "$ERR"; then echo 'SSH rejected the key. Add the public key shown in Settings to this server.'
    else echo "Can't connect over SSH. Check the host, port and user."; fi
    exit 1
  fi
  has() { grep -qx "$1" <<< "$OUT"; }
  if has uid=0; then echo 'Logged in as root. Use the account that owns the site files instead (see README).'; exit 1; fi
  has has-wp || { echo 'WP-CLI (wp) is not installed or not in the PATH on the server.'; exit 1; }
  has has-dump || { echo 'mysqldump is not available on the server.'; exit 1; }
  # Without rsync the server still lists and updates: only full backups need it
  echo OK; has has-rsync || echo no-rsync
  exit 0
fi

if [ "$MODE" = --json ]; then
  # Looks for wp-load.php: it marks a WordPress root even when wp-config.php sits one folder up.
  # Hidden folders (.trash, .cache…) are skipped.
  FOUND=$(remote "find ${WPU_PATH:-~} -maxdepth 5 -name wp-load.php -not -path '*/.*' 2>/dev/null | sed 's|/wp-load.php\$||' | sort" </dev/null) || exit 255
  SITES=(); SKIPPED=(); TODO=()
  while IFS= read -r P; do
    [ -n "$P" ] || continue
    [[ $P =~ $RE_PATH ]] || { echo "skipping unsupported path: $P" >&2; continue; }
    SITES+=("$P")
    if [[ ":$WPU_SKIP:" == *":$P:"* ]]; then SKIPPED+=("$P"); else TODO+=("$P"); fi
  done <<< "$FOUND"
  IFS=, read -ra EXCL <<< "$WPU_EXCLUDE"
  EXCL_JSON=$(json_list "${EXCL[@]}")
  EXCL_JSON=${EXCL_JSON//\"/\\\"}   # escaped: it goes inside the remote echo's double quotes
  echo "{\"server\":\"$WPU_SERVER\",\"sites\":$(json_list "${SITES[@]}"),\"skipped\":$(json_list "${SKIPPED[@]}")}"

  N=0
  for P in "${TODO[@]}"; do
    ID="$WPU_SERVER:$P"
    N=$((N+1))
    echo "===== [$N/${#TODO[@]}] $ID"
    # One JSON line per site; if the site fails, a line with "error" and on to the next one.
    # The --format=json values arrive already quoted for JSON.
    remote "bash -s" <<EOF || echo "{\"site\":\"$ID\",\"error\":\"could not list (no connection or not a WordPress)\"}"
$GUARD
set -eo pipefail
cd $P
# Clears the update list WordPress keeps in cache: otherwise it can show a stale one
wp transient delete update_plugins --network --quiet || true
wp transient delete update_themes --network --quiet || true
URL=\$(wp option get home --format=json)
DBN=\$(wp config get DB_NAME --format=json)
DBH=\$(wp config get DB_HOST --format=json)
DBP=\$(wp config get table_prefix --format=json)
WP=\$(wp core version)
CORE=\$(wp core check-update --force-check --format=json)
# Every plugin and theme with its update status, and what the new version needs. WP-CLI before 2.10
# has no requires fields ("Invalid field"): then only the available updates, as before
F=name,status,update,version,update_version
PLUGINS=\$(wp plugin list --fields=\$F,requires,requires_php --format=json 2>/dev/null) || PLUGINS=\$(wp plugin list --update=available --fields=\$F --format=json)
THEMES=\$(wp theme list --fields=\$F,requires,requires_php --format=json 2>/dev/null) || THEMES=\$(wp theme list --update=available --fields=\$F --format=json)
echo "{\"site\":\"$ID\",\"url\":\$URL,\"db\":{\"name\":\$DBN,\"host\":\$DBH,\"prefix\":\$DBP},\"wp\":\"\$WP\",\"exclude\":$EXCL_JSON,\"core\":\${CORE:-[]},\"plugins\":\${PLUGINS:-[]},\"themes\":\${THEMES:-[]}}"
EOF
  done
  exit 0
fi

if [ "$MODE" = --sizes ]; then
  # The files without the plugins' own backup folders (a full copy skips them), plus the database.
  # wp db size goes through $wpdb, so it works where the host disables proc_open
  for P in "$@"; do
    ID="$WPU_SERVER:$P"
    B=""
    if [[ $P =~ $RE_PATH ]]; then
      B=$(remote "bash -s" <<EOF
$GUARD
set -eo pipefail
cd $P
K=\$(du -sk . | cut -f1)
for X in wp-content/updraft wp-content/wpvividbackups; do [ ! -d \$X ] || K=\$((K - \$(du -sk \$X | cut -f1))); done
DB=\$(wp db size --size_format=b) || DB=0
echo \$((K * 1024 + DB))
EOF
) || B=""
    fi
    if [[ $B =~ ^[0-9]+$ ]]; then echo "{\"site\":\"$ID\",\"bytes\":$B}"; else echo "{\"site\":\"$ID\",\"error\":\"could not measure\"}"; fi
  done
  exit 0
fi

[ "$MODE" = --apply ] && [ $# -gt 0 ] || { echo "usage: updater.sh --probe | --json | --sizes <path>… | --apply <path>…" >&2; exit 2; }

# rsync takes the ssh command as one string; each option goes single-quoted so paths with spaces work
RSH=ssh; for O in "${SSH_OPTS[@]}"; do RSH+=" '$O'"; done
FAILED=()
N=0

for P in "$@"; do
  ID="$WPU_SERVER:$P"
  N=$((N+1))
  echo "===== [$N/$#] $ID"
  [[ $P =~ $RE_PATH ]] || { echo "== $ID: unsupported path, not updated"; FAILED+=("$ID (path)"); continue; }

  URL=$(remote "$GUARD; cd $P && wp option get home" </dev/null) || URL=""
  [[ $URL =~ ^https?://[^[:space:]\"]+$ ]] || { echo "== $ID: can't read the site address, not updated"; FAILED+=("$ID (address)"); continue; }
  # Backup folder named after the address: https://example.com/blog/ → example.com_blog
  NAME=${URL#*://}; NAME=${NAME//[\/:]/_}
  while [[ $NAME == *_ ]]; do NAME=${NAME%_}; done
  DIR="$WPU_BACKUPS/$WPU_USER@$WPU_HOST/$NAME"
  mkdir -p "$DIR"

  echo "== $ID: database backup"
  # wp db export doesn't work on some hosts (Hostinger disables proc_open()): mysqldump is called directly
  remote "bash -s" > "$DIR/database.sql.gz.tmp" <<EOF || { echo "== $ID: database backup failed, not updated"; FAILED+=("$ID (backup)"); continue; }
$GUARD
set -eo pipefail
cd $P
DUMP=\$(command -v mysqldump || command -v mariadb-dump)
DB_NAME="\$(wp config get DB_NAME)"
DB_USER="\$(wp config get DB_USER)"
DB_HOST="\$(wp config get DB_HOST)"
export MYSQL_PWD="\$(wp config get DB_PASSWORD)"
"\$DUMP" --single-transaction --no-tablespaces --default-character-set=utf8mb4 \
  -h "\$DB_HOST" -u "\$DB_USER" "\$DB_NAME" | gzip
EOF
  gzip -dc "$DIR/database.sql.gz.tmp" | tail -1 | grep -q "Dump completed" \
    || { echo "== $ID: database backup incomplete, not updated"; FAILED+=("$ID (backup)"); continue; }
  # Only the latest one is kept: the previous one is replaced only now that the new one is verified
  mv "$DIR/database.sql.gz.tmp" "$DIR/database.sql.gz"
  # To roll a plugin back: wp plugin install <name> --version=<the one in this file> --force
  remote "$GUARD; cd $P && wp plugin list --fields=name,status,version && wp theme list --fields=name,status,version" \
    </dev/null > "$DIR/versions-before.txt" || echo "warning: couldn't save versions-before.txt for $ID" >&2

  echo "== $ID: updating"
  remote "bash -s" <<EOF || { echo "== $ID: update failed"; FAILED+=("$ID (update)"); }
$GUARD
set -eo pipefail
cd $P
wp core update
wp core update-db
wp plugin update --all ${WPU_EXCLUDE:+--exclude=$WPU_EXCLUDE}
wp theme update --all ${WPU_EXCLUDE:+--exclude=$WPU_EXCLUDE}
wp language core update
wp language plugin update --all
wp language theme update --all
wp cache flush || true
wp litespeed-purge all || true
EOF

  CODE=$(curl -sL --max-time 60 -o /dev/null -w '%{http_code}' "$URL") || true
  if [ "$CODE" = 200 ]; then echo "== $ID: OK"; else echo "== $ID: site responds $CODE, check it"; FAILED+=("$ID (site $CODE)"); fi
done

[ ${#FAILED[@]} -eq 0 ] || { echo; echo "Check: ${FAILED[*]}"; exit 1; }
