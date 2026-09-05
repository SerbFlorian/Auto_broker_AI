import { bot } from '../index.js';
import { getRedis, isRedisReady } from '../db/redis.js';
import { CacheKeys } from './cache.service.js';
import { prisma } from '../db/prisma.js';
import {
  DigestSchedule,
  isUserWithinDeliveryWindow,
  loadDigestPrefs,
  nextUserWindowOpening,
  type DigestPrefs
} from './digestSchedule.service.js';

/**
 * VIP notification delivery — paced for a pleasant UX and light system load.
 *
 * The scheduler ticks often (NOTIF_TICK_MINUTES) but each user has their own clock
 * stored in Redis, so restarts never reset cadence and never cause double-sends.
 *
 * Per-user prefs (Postgres User + /schedule): days, start/end hours, interval 1–4h, pause.
 * System hard floor: NOTIF_HARD_START_HOUR / NOTIF_HARD_END_HOUR (default 7–23).
 * Defaults for new users: NOTIF_WINDOW_* (8–21) + NOTIF_INTERVAL_HOURS (default 2).
 *
 * After filters change: seed digest → wait 5–15 min → first send → then user interval cadence.
 * When a regular digest is due and Redis is empty, refill from inventory (newest unsent first).
 */
class NotificationQueueService {
  private localQueue = new Map<number, string[]>();
  private isProcessing = false;

  private readonly defaultIntervalMs: number;
  private readonly tickMs: number;
  private readonly firstDelayMinMs: number;
  private readonly firstDelayMaxMs: number;
  private readonly warmupMaxPerDay: number;
  private readonly maxMessagesPerUser: number;
  private readonly sendDelayMs: number;
  private readonly maxPendingPerUser: number;

  constructor() {
    const hours = Math.max(0.5, Number(process.env.NOTIF_INTERVAL_HOURS || 2));
    this.defaultIntervalMs = Math.round(hours * 60 * 60 * 1000);

    const tickMin = Math.max(1, Number(process.env.NOTIF_TICK_MINUTES || 5));
    this.tickMs = Math.round(tickMin * 60 * 1000);

    const minM = Math.max(1, Number(process.env.NOTIF_FIRST_DELAY_MIN_MINUTES || 5));
    const maxM = Math.max(minM, Number(process.env.NOTIF_FIRST_DELAY_MAX_MINUTES || 15));
    this.firstDelayMinMs = minM * 60 * 1000;
    this.firstDelayMaxMs = maxM * 60 * 1000;

    this.warmupMaxPerDay = Math.max(1, Number(process.env.NOTIF_WARMUP_MAX_PER_DAY || 2));
    this.maxMessagesPerUser = Math.max(1, Number(process.env.NOTIF_MAX_MESSAGES_PER_USER || 1));
    this.sendDelayMs = Math.max(200, Number(process.env.NOTIF_SEND_DELAY_MS || 800));
    this.maxPendingPerUser = Math.max(1, Number(process.env.NOTIF_MAX_PENDING_PER_USER || 3));
  }

  private intervalMsFor(prefs: DigestPrefs): number {
    const h = [1, 2, 3, 4].includes(prefs.intervalH) ? prefs.intervalH : 2;
    return h * 60 * 60 * 1000;
  }

  public async clearUserQueue(telegramId: number): Promise<void> {
    await DigestSchedule.reset(telegramId);
    this.localQueue.delete(telegramId);

    const redis = getRedis();
    if (redis && isRedisReady()) {
      try {
        await redis.del(CacheKeys.notifQueue(telegramId));
      } catch (err: any) {
        console.warn(`⚠️ [Queue] Failed to clear user queue: ${err.message}`);
      }
    }
  }

  public async enqueue(telegramId: number, message: string): Promise<void> {
    const redis = getRedis();
    if (redis && isRedisReady()) {
      try {
        const key = CacheKeys.notifQueue(telegramId);
        await redis.rpush(key, message);
        await redis.ltrim(key, -this.maxPendingPerUser, -1);
        return;
      } catch (err: any) {
        console.warn(`⚠️ [Queue] Redis enqueue failed, using memory: ${err.message}`);
      }
    }

    const userQueue = this.localQueue.get(telegramId) || [];
    userQueue.push(message);
    while (userQueue.length > this.maxPendingPerUser) {
      userQueue.shift();
    }
    this.localQueue.set(telegramId, userQueue);
  }

  /**
   * After filter Done + seed: deliver this user's queue once after a random 5–15 min wait.
   * Capped by NOTIF_WARMUP_MAX_PER_DAY so repeatedly re-saving filters cannot farm digests.
   * Resets the cadence clock from that first send.
   */
  public async scheduleFirstDeliveryAfterFilterChange(telegramId: number): Promise<void> {
    // Peek only — quota is consumed after a successful warmup send so empty
    // queues never burn the VIP's post-filter seed.
    const used = await DigestSchedule.warmupQuotaUsed(telegramId);
    if (used >= this.warmupMaxPerDay) {
      console.log(
        `📦 [Queue] User ${telegramId}: warmup quota spent (${used}/${this.warmupMaxPerDay} in 24h) — normal cadence only.`
      );
      return;
    }

    const prefs = await loadDigestPrefs(telegramId);
    if (prefs.paused) {
      console.log(`📦 [Queue] User ${telegramId}: digests paused — warmup not scheduled.`);
      return;
    }

    const span = this.firstDelayMaxMs - this.firstDelayMinMs;
    const delayMs = this.firstDelayMinMs + Math.floor(Math.random() * (span + 1));
    let dueAt = Date.now() + delayMs;

    // Never wake anyone outside their window/days: push to next opening + small jitter.
    if (!isUserWithinDeliveryWindow(prefs, new Date(dueAt))) {
      dueAt =
        nextUserWindowOpening(prefs, new Date(dueAt)) +
        Math.floor(Math.random() * 10 * 60 * 1000);
    }

    await DigestSchedule.setWarmup(telegramId, dueAt);
    console.log(
      `📦 [Queue] User ${telegramId}: warmup digest due ${new Date(dueAt).toISOString()} ` +
        `(warmup ${used}/${this.warmupMaxPerDay} used today, then ${prefs.intervalH}h cadence).`
    );
  }

  public start() {
    const hours = this.defaultIntervalMs / (60 * 60 * 1000);
    setInterval(() => void this.processQueue(), this.tickMs);
    console.log(
      `📦 Queue Service started: tick ${this.tickMs / 60000} min · default interval ${hours}h ` +
        `(per-user /schedule overrides; warmup ${this.firstDelayMinMs / 60000}–${this.firstDelayMaxMs / 60000} min, max ${this.warmupMaxPerDay}/24h; ` +
        `pending cap ${this.maxPendingPerUser}, ${this.sendDelayMs}ms spacing).`
    );

    setTimeout(() => void this.processQueue(), 60_000);
  }

  private async listTelegramIds(): Promise<number[]> {
    const ids = new Set<number>();

    const redis = getRedis();
    if (redis && isRedisReady()) {
      try {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', 'notif:q:*', 'COUNT', 200);
          cursor = next;
          for (const key of keys) {
            const id = Number(key.replace('notif:q:', ''));
            if (!Number.isNaN(id)) ids.add(id);
          }
        } while (cursor !== '0');
      } catch {
        // fall through to VIP query + memory
      }
    }

    for (const id of this.localQueue.keys()) ids.add(id);

    // Include VIP users even with an empty Redis queue so we can refill from inventory
    try {
      const vips = await prisma.user.findMany({
        where: {
          subscriptionStatus: { in: ['vip', 'cancelling'] },
          digestPaused: false,
          alerts: { some: {} }
        },
        select: { telegramId: true }
      });
      for (const u of vips) ids.add(Number(u.telegramId));
    } catch (err: any) {
      console.warn(`⚠️ [Queue] VIP id scan failed: ${err.message}`);
    }

    return Array.from(ids);
  }

  private async popBurst(telegramId: number, max: number): Promise<string[]> {
    const redis = getRedis();
    if (redis && isRedisReady()) {
      try {
        const key = CacheKeys.notifQueue(telegramId);
        const burst: string[] = [];
        for (let i = 0; i < max; i++) {
          const msg = await redis.lpop(key);
          if (!msg) break;
          burst.push(msg);
        }
        if (burst.length > 0) return burst;
      } catch {
        // fall through
      }
    }

    const local = this.localQueue.get(telegramId) || [];
    const burst = local.splice(0, max);
    if (local.length === 0) this.localQueue.delete(telegramId);
    else this.localQueue.set(telegramId, local);
    return burst;
  }

  private async isEligibleForDigest(telegramId: number): Promise<boolean> {
    try {
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        select: {
          subscriptionStatus: true,
          alerts: { select: { id: true }, take: 1 }
        }
      });
      if (!user) return false;
      if (user.subscriptionStatus !== 'vip' && user.subscriptionStatus !== 'cancelling') {
        return false;
      }
      if (!user.alerts.length) return false;
      return true;
    } catch {
      return true;
    }
  }

  private async deliverUserNow(
    telegramId: number,
    reason: 'filter-first' | 'cycle',
    prefs: DigestPrefs
  ): Promise<void> {
    const eligible = await this.isEligibleForDigest(telegramId);
    if (!eligible) {
      await this.clearUserQueue(telegramId);
      return;
    }

    const gotLock = await DigestSchedule.acquireSendLock(telegramId);
    if (!gotLock) return;

    let burst = await this.popBurst(telegramId, this.maxMessagesPerUser);

    // Queue empty → pull next unsent matches from DB (newest first, then older)
    if (burst.length === 0) {
      try {
        const { MatchingService } = await import('./matching.service.js');
        const filled = await MatchingService.refillDigestFromInventory(telegramId);
        if (filled) {
          burst = await this.popBurst(telegramId, this.maxMessagesPerUser);
        }
      } catch (err: any) {
        console.warn(
          `⚠️ [Queue] Inventory refill failed for ${telegramId}: ${err.message}`
        );
      }
    }

    if (burst.length === 0) {
      if (reason === 'filter-first') {
        // Keep the warmup alive and retry soon — seed may still be writing.
        // Do NOT consume quota and do NOT clear the warmup key.
        const retryAt = Date.now() + 5 * 60 * 1000;
        await DigestSchedule.setWarmup(telegramId, retryAt);
        console.log(
          `📦 [Queue] User ${telegramId}: warmup due but queue empty — retry ${new Date(retryAt).toISOString()} (quota untouched).`
        );
      } else {
        // No unsent stock right now — still advance cadence (avoid 5‑min DB spin)
        await DigestSchedule.setNextRegularAt(
          telegramId,
          Date.now() + this.intervalMsFor(prefs)
        );
        console.log(
          `📦 [Queue] User ${telegramId}: due but no unsent matches — next in ${prefs.intervalH}h.`
        );
      }
      return;
    }

    let sent = false;
    for (const msg of burst) {
      try {
        await bot.telegram.sendMessage(telegramId, msg, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true }
        });
        sent = true;
        await new Promise((r) => setTimeout(r, this.sendDelayMs));
      } catch (error) {
        console.error(`❌ [Queue] Error sending message to user ${telegramId}:`, error);
        try {
          const plain = msg.replace(/<[^>]+>/g, '');
          await bot.telegram.sendMessage(telegramId, plain, {
            link_preview_options: { is_disabled: true }
          });
          sent = true;
        } catch (e2) {
          console.error(`❌ [Queue] Plain fallback also failed for ${telegramId}:`, e2);
        }
      }
    }

    if (sent) {
      if (reason === 'filter-first') {
        await DigestSchedule.consumeWarmupQuota(telegramId);
        await DigestSchedule.clearWarmup(telegramId);
      }
      await DigestSchedule.setNextRegularAt(
        telegramId,
        Date.now() + this.intervalMsFor(prefs)
      );
      console.log(
        `📦 [Queue] Delivered to ${telegramId} (${reason}, next in ${prefs.intervalH}h).`
      );
    } else if (reason === 'filter-first') {
      // Send failed — keep warmup so the next tick can retry without burning quota.
      const retryAt = Date.now() + 5 * 60 * 1000;
      await DigestSchedule.setWarmup(telegramId, retryAt);
    }
  }

  /** Decides, per user, whether a digest is due right now. */
  private async dueReason(telegramId: number): Promise<'filter-first' | 'cycle' | null> {
    const now = Date.now();

    const warmupAt = await DigestSchedule.getWarmupDueAt(telegramId);
    if (warmupAt !== null) {
      if (now < warmupAt) return null; // waiting for the warmup window — don't send early
      // Leave the warmup key in place until a successful send (see deliverUserNow).
      return 'filter-first';
    }

    const nextAt = await DigestSchedule.getNextRegularAt(telegramId);
    if (nextAt === null || now >= nextAt) return 'cycle';
    return null;
  }

  private async processQueue() {
    await this.runFlushTick();
  }

  /**
   * Regular tick: VIP users who are due (warmup or next_regular) and inside /schedule window.
   * Drains Redis `notif:q:{id}` → Telegram; refills from inventory if empty.
   */
  public async runFlushTick(): Promise<number> {
    if (this.isProcessing) {
      console.log('📦 [Queue] Flush already running — skip.');
      return 0;
    }
    this.isProcessing = true;

    try {
      const telegramIds = await this.listTelegramIds();
      if (telegramIds.length === 0) return 0;

      let delivered = 0;
      for (const telegramId of telegramIds) {
        const prefs = await loadDigestPrefs(telegramId);
        if (prefs.paused || !isUserWithinDeliveryWindow(prefs)) continue;

        const reason = await this.dueReason(telegramId);
        if (!reason) continue;
        await this.deliverUserNow(telegramId, reason, prefs);
        delivered++;
      }

      if (delivered > 0) {
        console.log(
          `📦 [Queue] Flush tick: ${delivered}/${telegramIds.length} user(s) got a digest.`
        );
      } else {
        console.log(
          `📦 [Queue] Flush tick: nobody due (${telegramIds.length} VIP candidate(s)).`
        );
      }
      return delivered;
    } catch (error) {
      console.error('❌ [Queue] Critical error processing the queue:', error);
      return 0;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * CLI / ops: drain one user's Redis digest queue → Telegram DM.
   * If the queue is empty, refill once from inventory then send.
   * Does not use --force flags; ignores /schedule window (manual ops send).
   */
  public async flushUserQueueNow(telegramId: number): Promise<boolean> {
    const eligible = await this.isEligibleForDigest(telegramId);
    if (!eligible) {
      console.warn(
        `📦 [Queue] flush: ${telegramId} not eligible (need VIP + saved filters).`
      );
      return false;
    }

    // Free send lock if a stuck lock blocks delivery
    await DigestSchedule.reset(telegramId);

    const prefs = await loadDigestPrefs(telegramId);
    console.log(`📦 [Queue] flush → ${telegramId} (Redis queue → Telegram)…`);
    await this.deliverUserNow(telegramId, 'cycle', prefs);
    return true;
  }
}

export const queueService = new NotificationQueueService();
