/**
 * Live VIP counter for the admin chat.
 *
 * One single message is kept up to date (edited in place) instead of spamming the
 * chat on every subscription event, so the admin always sees the current seat count
 * and which Stripe price tier new subscribers land on.
 *
 * The message id is persisted three levels deep: memory → Redis → AppMeta (Postgres),
 * so a container restart or a Redis flush never orphans the box.
 */
import { prisma } from '../db/prisma.js';
import { getRedis, isRedisReady } from '../db/redis.js';

const META_KEY = 'vip_counter_message_id';
const REDIS_KEY = 'ops:vipbox:msgid';

let cachedMessageId: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let pendingRefresh = false;

export interface VipTier {
  index: 1 | 2 | 3;
  label: string;
  /** Human range shown in the admin box (VIP seat count bands). */
  range: string;
  envVar: string;
}

/**
 * Soft-launch pricing bands (3 Stripe Payment Links: ~30 / ~60 / ~100 €).
 * Keep in sync with getDynamicPaymentLink() in index.ts (uses this helper).
 */
export function tierForVipCount(vipCount: number): VipTier {
  if (vipCount <= 200) {
    return { index: 1, label: 'Tier 1', range: '0–200', envVar: 'STRIPE_PAYMENT_LINK_TIER1' };
  }
  if (vipCount <= 500) {
    return { index: 2, label: 'Tier 2', range: '201–500', envVar: 'STRIPE_PAYMENT_LINK_TIER2' };
  }
  return { index: 3, label: 'Tier 3', range: '501+', envVar: 'STRIPE_PAYMENT_LINK_TIER3' };
}

export async function getVipCount(): Promise<number> {
  return prisma.user.count({
    where: { subscriptionStatus: { in: ['vip', 'cancelling'] } }
  });
}

/** ASCII seat box — big, unambiguous, copy-friendly on mobile. */
function renderBox(count: number): string {
  const text = String(count);
  const inner = ` ${text} `.padStart(text.length + 2).padEnd(Math.max(5, text.length + 4));
  const bar = '─'.repeat(inner.length);
  return [`┌${bar}┐`, `│${inner}│`, `└${bar}┘`].join('\n');
}

export function renderVipCounterHtml(count: number, now = new Date()): string {
  const tier = tierForVipCount(count);
  const stamp = now.toLocaleString('es-ES', {
    timeZone: process.env.TZ || 'Europe/Madrid',
    dateStyle: 'short',
    timeStyle: 'medium'
  });

  return (
    `🏛️ <b>AutoBroker AI</b>\n` +
    `💎 <b>Active VIPs</b>\n\n` +
    `<pre>${renderBox(count)}</pre>\n` +
    `Current price: <b>${tier.label}</b> (${tier.range})\n` +
    `<i>${stamp}</i>`
  );
}

async function readStoredMessageId(): Promise<number | null> {
  if (cachedMessageId != null) return cachedMessageId;

  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      const raw = await redis.get(REDIS_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) {
        cachedMessageId = n;
        return n;
      }
    } catch {
      /* fall through to Postgres */
    }
  }

  try {
    const row = await prisma.appMeta.findUnique({ where: { key: META_KEY } });
    const n = row ? Number(row.value) : NaN;
    if (Number.isFinite(n) && n > 0) {
      cachedMessageId = n;
      return n;
    }
  } catch {
    /* AppMeta may not exist yet on a very old schema */
  }

  return null;
}

async function storeMessageId(messageId: number | null): Promise<void> {
  cachedMessageId = messageId;

  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      if (messageId == null) await redis.del(REDIS_KEY);
      else await redis.set(REDIS_KEY, String(messageId));
    } catch {
      /* ignore */
    }
  }

  try {
    if (messageId == null) {
      await prisma.appMeta.deleteMany({ where: { key: META_KEY } });
    } else {
      await prisma.appMeta.upsert({
        where: { key: META_KEY },
        create: { key: META_KEY, value: String(messageId) },
        update: { value: String(messageId) }
      });
    }
  } catch {
    /* ignore — Redis/memory still carry the id for this process */
  }
}

function adminChatId(): string | null {
  const raw = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  return raw ? raw : null;
}

function adminTopicId(): number | undefined {
  const raw = parseInt(process.env.TELEGRAM_ADMIN_TOPIC_ID || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function isNotModified(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('message is not modified');
}

/**
 * Refresh the pinned VIP box. `force: true` posts a brand-new message (used by /vip_count).
 * Concurrent calls collapse into one refresh plus at most one queued follow-up.
 */
export async function refreshVipCounter(opts: { force?: boolean } = {}): Promise<void> {
  if (refreshInFlight && !opts.force) {
    pendingRefresh = true;
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      await doRefresh(opts.force === true);
    } catch (err) {
      console.warn('⚠️ [VIP box] Refresh failed:', err instanceof Error ? err.message : err);
    } finally {
      refreshInFlight = null;
    }
  })();

  await refreshInFlight;

  if (pendingRefresh) {
    pendingRefresh = false;
    await refreshVipCounter();
  }
}

async function doRefresh(force: boolean): Promise<void> {
  const chatId = adminChatId();
  if (!chatId) return;

  const { bot } = await import('../index.js');
  const count = await getVipCount();
  const html = renderVipCounterHtml(count);
  const threadId = adminTopicId();

  if (!force) {
    const existing = await readStoredMessageId();
    if (existing != null) {
      try {
        await bot.telegram.editMessageText(chatId, existing, undefined, html, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true }
        });
        return;
      } catch (err) {
        if (isNotModified(err)) return;
        // Message was deleted or is too old to edit → fall through and post a new one.
        await storeMessageId(null);
      }
    }
  }

  const sent = await bot.telegram.sendMessage(chatId, html, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(threadId ? { message_thread_id: threadId } : {})
  });

  await storeMessageId(sent.message_id);

  if (process.env.VIP_COUNTER_PIN === 'true') {
    try {
      await bot.telegram.pinChatMessage(chatId, sent.message_id, {
        disable_notification: true
      });
    } catch {
      /* pinning needs admin rights in the group — non-fatal */
    }
  }
}

/** Fire-and-forget helper for hot paths (Stripe webhooks, purges). */
export function scheduleVipCounterRefresh(delayMs = 1500): void {
  if (!adminChatId()) return;
  setTimeout(() => void refreshVipCounter(), delayMs);
}
