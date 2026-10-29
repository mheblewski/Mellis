#!/bin/sh
# Nightly database dump (custom format) kept for 14 days in deploy/backups.
# Host crontab:  15 3 * * * /opt/gluco-mind/deploy/backup.sh >> /opt/gluco-mind/deploy/backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")"
mkdir -p backups
umask 077
file="backups/glucomind-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U glucomind -d glucomind -Fc > "$file.tmp"
mv "$file.tmp" "$file"
find backups -name 'glucomind-*.dump' -mtime +14 -delete
echo "$(date -u +%FT%TZ) backup ok: $file ($(du -h "$file" | cut -f1))"
