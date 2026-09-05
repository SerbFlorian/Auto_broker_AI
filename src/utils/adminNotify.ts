/**
 * Critical-only admin alerts via Telegram Bot API (no Telegraf import → no cycles).
 * Used for: startup crash, backup failure, fatal process errors.
 * Never used for routine backup dumps or success spam.
 *
 * Blast radius: the scraper container holds NO bot token. When the token is absent
 * the alert is pushed to a Redis relay list and the app container forwards it,
 * so scraper failures still reach the admin chat without duplicating the secret.
 *
 * Local / CI false positives: never page Telegram when DATABASE_URL points at
 * localhost outside Docker (e.g. accidental `npm test` import that tried to boot
 * with `.env` → 127.0.0.1:5435). Compose overrides DATABASE_URL to `postgresql:5432`.
 */
import { existsSync } from 'fs';
import { redactSecrets } from './secrets.js';

const lastSentAt = new Map<string, number>();

/** Redis list used to relay CRITICAL alerts from tokenless containers to the app. */
export const CRITICAL_RELAY_KEY = 'ops:critical';
const RELAY_MAX_ITEMS = 50;
const RELAY_TTL_SECONDS = 24 * 60 * 60;

function cooldownMs(): number {
  const n = parseInt(process.env.ADMIN_ALERT_COOLDOWN_MS || '900000', 10);
  return Number.isFinite(n) && n >= 0 ? n : 900_000;
}

function fingerprint(message: string): string {
  return message.replace(/\d+/g, '#').slice(0, 180);
}

function isRunningInDocker(): boolean {
  try {
    return existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function databaseUrlLooksLocal(): boolean {
  const db = process.env.DATABASE_URL || '';
  return /@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(db);
}

/** True when this process should never spam the admin Telegram chat. */
export function shouldSuppressAdminAlerts(): boolean {
  if (process.env.ADMIN_ALERTS_DISABLED === 'true') return true;
  if (process.env.NODE_ENV === 'test') return true;
  // Host-side scripts / accidental imports with the repo `.env` (local Prisma port).
  // Production containers use hostname `postgresql` and have `/.dockerenv`.
  if (databaseUrlLooksLocal() && !isRunningInDocker()) return true;
  return false;
}

async function sendToTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('❌ Admin notify HTTP', res.status, redactSecrets(body));
      return false;
    }
    return true;
  } catch (err) {
    console.error('❌ Admin notify failed:', redactSecrets(err));
    return false;
  }
}

async function pushToRelay(text: string): Promise<boolean> {
  try {
    const { getRedis, isRedisReady } = await import('../db/redis.js');
    const redis = getRedis();
    if (!redis || !isRedisReady()) return false;

    await redis.rpush(CRITICAL_RELAY_KEY, text);
    await redis.ltrim(CRITICAL_RELAY_KEY, -RELAY_MAX_ITEMS, -1);
    await redis.expire(CRITICAL_RELAY_KEY, RELAY_TTL_SECONDS);
    return true;
  } catch (err) {
    console.warn('⚠️ [Admin] Relay push failed:', redactSecrets(err));
    return false;
  }
}

export async function notifyAdminCritical(message: string): Promise<void> {
  if (shouldSuppressAdminAlerts()) {
    console.warn(
      '⚠️ [Admin] CRITICAL suppressed (local/test — not paging Telegram):',
      redactSecrets(message).slice(0, 120)
    );
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();

  const safe = redactSecrets(message).slice(0, 3900);
  const key = fingerprint(safe);
  const now = Date.now();
  const last = lastSentAt.get(key) || 0;
  const cd = cooldownMs();
  if (cd > 0 && now - last < cd) {
    console.warn('⚠️ [Admin] CRITICAL suppressed (cooldown):', key.slice(0, 80));
    return;
  }
  lastSentAt.set(key, now);

  if (token && chatId) {
    await sendToTelegram(token, chatId, safe);
    return;
  }

  const role = (process.env.WORKER_MODE || 'all').trim().toLowerCase();
  const relayed = await pushToRelay(`🛰️ *[${role}]*\n${safe}`);
  if (!relayed) {
    console.error('❌ [Admin] CRITICAL not deliverable (no token, no relay):', safe.slice(0, 200));
  }
}

/**
 * App role only: forward CRITICAL alerts queued by tokenless containers (scraper).
 * Returns how many alerts were relayed.
 */
export async function drainCriticalRelay(): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (!token || !chatId) return 0;

  try {
    const { getRedis, isRedisReady } = await import('../db/redis.js');
    const redis = getRedis();
    if (!redis || !isRedisReady()) return 0;

    let sent = 0;
    for (let i = 0; i < RELAY_MAX_ITEMS; i++) {
      const item = await redis.lpop(CRITICAL_RELAY_KEY);
      if (!item) break;
      const ok = await sendToTelegram(token, chatId, item.slice(0, 3900));
      if (!ok) break;
      sent++;
    }
    return sent;
  } catch (err) {
    console.warn('⚠️ [Admin] Relay drain failed:', redactSecrets(err));
    return 0;
  }
}

/** App role only: poll the relay so scraper CRITICALs surface within ~1 minute. */
export function startCriticalRelayDrain(): void {
  const everyMs = Math.max(
    15_000,
    parseInt(process.env.ADMIN_RELAY_POLL_MS || '60000', 10) || 60_000
  );
  const tick = async () => {
    const n = await drainCriticalRelay();
    if (n > 0) console.log(`🛰️ [Admin] Relayed ${n} CRITICAL alert(s) from other containers.`);
  };
  setInterval(() => void tick(), everyMs);
  setTimeout(() => void tick(), 10_000);
  console.log(`🛰️ [Admin] CRITICAL relay drain every ${Math.round(everyMs / 1000)}s.`);
}
