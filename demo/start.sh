#!/bin/bash
# Runs at every container start: the database, the web server, and sshd in the foreground.
set -e
service mariadb start
apache2ctl start
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
