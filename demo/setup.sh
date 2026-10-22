#!/bin/bash
# Runs once, at image build time: the demo account, sshd, Apache and three outdated WordPress sites.
# Every new container starts from this state, so recreating the container resets the demo.
set -euo pipefail

# ---- SSH: key only, never root. The key is the app's own, read from the shared volume at every login.
useradd -m -s /bin/bash demo
usermod -p '*' demo   # no password, but not a locked account
chmod 755 /home/demo  # Apache reads the sites from here
ssh-keygen -A
cat > /etc/ssh/sshd_config.d/demo.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AuthorizedKeysCommand /usr/bin/cat /ssh/id_ed25519.pub
AuthorizedKeysCommandUser nobody
EOF

curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
chmod 755 /usr/local/bin/wp

# ---- One Apache site per WordPress, reached by the app through the siteN.demo network aliases
echo 'ServerName localhost' > /etc/apache2/conf-available/servername.conf
a2enconf -q servername
for N in 1 2 3; do
  cat > "/etc/apache2/sites-available/site$N.conf" <<EOF
<VirtualHost *:80>
  ServerName site$N.demo
  DocumentRoot /home/demo/sites/site$N
  <Directory /home/demo/sites/site$N>
    AllowOverride All
    Require all granted
  </Directory>
</VirtualHost>
EOF
  a2ensite -q "site$N"
done

# ---- The sites. Old versions on purpose: there must be real updates to apply. Each plugin's latest
# version must fit the image's PHP and the site's WordPress, or WP-CLI marks its update "unavailable".
wp() { runuser -u demo -- env HOME=/home/demo /usr/local/bin/wp "$@"; }
# site <n> <core version> <theme:version> <plugin:version>…
site() {
  local N=$1 CORE=$2 THEME=$3 P=/home/demo/sites/site$1
  shift 3
  mariadb -e "CREATE DATABASE site$N; CREATE USER 'site$N'@'localhost' IDENTIFIED BY 'demo-site$N';
              GRANT ALL ON site$N.* TO 'site$N'@'localhost';"
  wp core download --path="$P" --version="$CORE" --skip-content
  wp config create --path="$P" --dbname="site$N" --dbuser="site$N" --dbpass="demo-site$N" --dbhost=localhost --extra-php <<'PHP'
define( 'AUTOMATIC_UPDATER_DISABLED', true ); // only WP Updater updates the demo
define( 'DISABLE_WP_CRON', true );
PHP
  wp core install --path="$P" --url="http://site$N.demo" --title="Demo site $N" \
    --admin_user=demo --admin_password=demo --admin_email=demo@example.com --skip-email
  wp theme install --path="$P" "${THEME%:*}" --version="${THEME#*:}" --activate
  for X in "$@"; do wp plugin install --path="$P" "${X%:*}" --version="${X#*:}"; done
}

service mariadb start
install -d -o demo -g demo /home/demo/sites
site 1 6.5.5  twentytwentyone:1.7   classic-editor:1.6.2 wordpress-importer:0.8 classic-widgets:0.2
site 2 latest twentytwentytwo:1.2   classic-widgets:0.2 wordpress-importer:0.8
site 3 latest twentytwentythree:1.0 akismet:5.0 classic-editor:1.6.2
# A file copy of site1 on the same database: WP Updater must flag both and update neither
cp -a /home/demo/sites/site1 /home/demo/sites/site1-old
service mariadb stop
rm -rf /home/demo/.wp-cli/cache   # downloaded zips: not needed once installed
