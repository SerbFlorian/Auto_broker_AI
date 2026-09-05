#!/usr/bin/env bash
# Cron wrapper around verify-system.sh.
#   0 8 * * * /home/florian/Auto_broker_AI/scripts/verify-and-notify.sh >> /var/log/autobroker-verify.log 2>&1
#
# Alerts the admin chat only on transitions (OK → FAIL and FAIL → OK), so a broken
# check does not send the same message every single day.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

STATE_FILE="${VERIFY_STATE_FILE:-/tmp/autobroker-verify.state}"

# Secrets come from .env, never from the crontab line.
if [ -f .env ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_ADMIN_CHAT_ID)=' .env | xargs -d '\n' 2>/dev/null) || true
fi

send_telegram() {
  local text="$1"
  [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && return 0
  [ -z "${TELEGRAM_ADMIN_CHAT_ID:-}" ] && return 0
  curl -fsS --max-time 15 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${text}" >/dev/null || true
}

OUTPUT=$(./scripts/verify-system.sh 2>&1)
STATUS=$?

PREVIOUS=$(cat "$STATE_FILE" 2>/dev/null || echo "ok")
CURRENT=$([ $STATUS -eq 0 ] && echo "ok" || echo "fail")
echo "$CURRENT" > "$STATE_FILE"

echo "$OUTPUT"

if [ "$CURRENT" = "fail" ] && [ "$PREVIOUS" != "fail" ]; then
  # Telegram caps messages at 4096 chars; keep the tail where the failures are.
  TAIL=$(echo "$OUTPUT" | grep -E '^(❌|⚠️)' | head -n 25)
  send_telegram "🚨 AutoBroker verification FAILED ($(date '+%Y-%m-%d %H:%M'))

${TAIL}

Run: ./scripts/verify-system.sh"
elif [ "$CURRENT" = "ok" ] && [ "$PREVIOUS" = "fail" ]; then
  send_telegram "✅ AutoBroker verification recovered ($(date '+%Y-%m-%d %H:%M')). All checks pass again."
fi

exit $STATUS
