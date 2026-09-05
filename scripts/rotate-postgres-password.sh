#!/usr/bin/env bash
# Rotate Postgres password for an existing Auto Broker volume.
# Usage (on VPS): bash scripts/rotate-postgres-password.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env"
  exit 1
fi

chmod 600 .env || true

NEW_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
OLD_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)"
OLD_USER="${OLD_USER:-johndoe}"
OLD_DB="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)"
OLD_DB="${OLD_DB:-autobroker_db}"

echo "Setting new POSTGRES_PASSWORD in .env and altering role inside container…"

if grep -q '^POSTGRES_PASSWORD=' .env; then
  sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${NEW_PASS}|" .env
else
  echo "POSTGRES_PASSWORD=${NEW_PASS}" >> .env
fi

docker compose exec -T postgresql \
  psql -U "$OLD_USER" -d "$OLD_DB" \
  -c "ALTER USER \"${OLD_USER}\" WITH PASSWORD '${NEW_PASS}';"

echo "Done. Rebuild/recreate app so DATABASE_URL picks up the new password:"
echo "  docker compose up -d --force-recreate app"
echo "Keep .env at chmod 600. Backup .env.bak if created, then delete it."
