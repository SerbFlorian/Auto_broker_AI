#!/usr/bin/env bash
# Host-side production self-check for AutoBroker AI.
#   ./scripts/verify-system.sh
# Exit 0 = healthy, 1 = something needs attention.
#
# Covers what only the host can see (containers, disk) and then delegates the
# application checks to scripts/verify-system.ts inside the app container.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0
REPORT=""

log() {
  echo -e "$1"
  REPORT="${REPORT}$1\n"
}

fail() {
  log "❌ $1"
  FAILURES=$((FAILURES + 1))
}

ok() {
  log "✅ $1"
}

warn() {
  log "⚠️  $1"
}

log "🔎 AutoBroker AI — host verification ($(date '+%Y-%m-%d %H:%M:%S'))"
log ""

# --- 1. Containers -----------------------------------------------------------
EXPECTED_SERVICES=(app scraper postgresql redis)
for svc in "${EXPECTED_SERVICES[@]}"; do
  state=$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk -v s="$svc" '$1==s {print $2" "$3}')
  if [ -z "$state" ]; then
    fail "container ${svc}: not found"
    continue
  fi
  run_state=$(echo "$state" | awk '{print $1}')
  health=$(echo "$state" | awk '{print $2}')
  if [ "$run_state" != "running" ]; then
    fail "container ${svc}: ${run_state}"
  elif [ -n "$health" ] && [ "$health" != "healthy" ] && [ "$health" != "<nil>" ]; then
    fail "container ${svc}: running but ${health}"
  else
    ok "container ${svc}: running${health:+ (${health})}"
  fi
done

# --- 2. Restart loops --------------------------------------------------------
for svc in "${EXPECTED_SERVICES[@]}"; do
  cid=$(docker compose ps -q "$svc" 2>/dev/null)
  [ -z "$cid" ] && continue
  restarts=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)
  if [ "${restarts:-0}" -gt 5 ]; then
    warn "container ${svc}: ${restarts} restarts since creation"
  fi
done

# --- 3. Local health endpoint ------------------------------------------------
if curl -fsS --max-time 5 http://127.0.0.1:3003/health | grep -q '"status":"ok"'; then
  ok "health endpoint: 200 ok"
else
  fail "health endpoint: no ok response on 127.0.0.1:3003/health"
fi

# --- 4. Disk -----------------------------------------------------------------
DISK_USED=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ "${DISK_USED:-0}" -ge 90 ]; then
  fail "disk: ${DISK_USED}% used on /"
elif [ "${DISK_USED:-0}" -ge 80 ]; then
  warn "disk: ${DISK_USED}% used on /"
else
  ok "disk: ${DISK_USED}% used on /"
fi

# --- 5. Application checks (inside the app container) ------------------------
log ""
APP_OUTPUT=$(docker compose exec -T app npx tsx scripts/verify-system.ts 2>&1)
APP_STATUS=$?
log "$APP_OUTPUT"
if [ $APP_STATUS -ne 0 ]; then
  FAILURES=$((FAILURES + 1))
fi

log ""
if [ $FAILURES -eq 0 ]; then
  log "✅ ALL CHECKS PASSED"
else
  log "❌ ${FAILURES} CHECK GROUP(S) FAILED"
fi

exit $([ $FAILURES -eq 0 ] && echo 0 || echo 1)
