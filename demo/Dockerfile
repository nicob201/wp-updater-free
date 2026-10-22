# A fake server to try WP Updater safely: SSH + WP-CLI + WordPress sites with outdated plugins and themes.
# Start: docker compose --profile demo up -d · Reset: docker compose --profile demo up -d --force-recreate demo
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server rsync curl ca-certificates \
      apache2 libapache2-mod-php php-cli php-mysql php-curl php-xml php-mbstring php-zip php-gd \
      mariadb-server mariadb-client \
 && rm -rf /var/lib/apt/lists/*

COPY setup.sh start.sh /usr/local/bin/
RUN bash /usr/local/bin/setup.sh

CMD ["bash", "/usr/local/bin/start.sh"]
