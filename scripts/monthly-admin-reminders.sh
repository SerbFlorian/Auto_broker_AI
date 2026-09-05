#!/usr/bin/env bash
# Monthly ops reminder for the admin chat — the maintenance that has no cron.
#   0 9 1 * * /home/florian/Auto_broker_AI/scripts/monthly-admin-reminders.sh >> /var/log/autobroker-reminders.log 2>&1

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if [ -f .env ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_ADMIN_CHAT_ID)=' .env | xargs -d '\n' 2>/dev/null) || true
fi

[ -z "${TELEGRAM_BOT_TOKEN:-}" ] && exit 0
[ -z "${TELEGRAM_ADMIN_CHAT_ID:-}" ] && exit 0

MONTH=$(date '+%B %Y')
DISK=$(df -h / | awk 'NR==2 {print $3" / "$2" ("$5")"}')
DOCKER_DISK=$(docker system df --format '{{.Type}}: {{.Size}} (reclaimable {{.Reclaimable}})' 2>/dev/null | paste -sd '; ' -)

read -r -d '' TEXT <<EOF || true
🗓️ AutoBroker AI — monthly ops checklist (${MONTH})

Disk: ${DISK}
Docker: ${DOCKER_DISK:-n/a}

To review this month:
• Restore drill: restore the latest R2 dump into a scratch DB and confirm the row counts.
• Rotate credentials older than 90 days (Postgres, Redis, R2, Bright Data).
• Check OpenAI + Bright Data spend against the VIP count (target: API cost < 10% of MRR).
• Review scraper yield per portal and disable any source that stopped returning listings.
• Prune Docker if reclaimable space is high: docker image prune -a
• Check Stripe tier: /vip_count — move the payment link when the seat band changes.
EOF

curl -fsS --max-time 15 \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
  -d "disable_web_page_preview=true" \
  --data-urlencode "text=${TEXT}" >/dev/null || true
