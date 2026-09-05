/**
 * Per-user digest scheduling state + delivery prefs.
 *
 * Redis keys (per telegramId):
 *   digest:warmup:{id}        → epoch ms when the post-filter-change digest is due
 *   digest:warmup_quota:{id}  → warmups consumed in the last 24h (anti re-save abuse)
 *   digest:next:{id}          → epoch ms when the next regular digest is allowed
 *   digest:lock:{id}          → short lock so overlapping ticks never send twice
 *   digest:prefs:{id}         → JSON cache of User digest prefs (short TTL)
 *
 * Delivery window uses Europe/Madrid via process TZ (Compose sets TZ=Europe/Madrid).
 * Hard night floor (NOTIF_HARD_*): users cannot schedule outside 7–23 by default.
 */
import { getRedis, isRedisReady } from '../db/redis.js';
import { prisma } from '../db/prisma.js';

const memory = new Map<string, { value: string; expiresAt: number }>();

function memGet(key: string): string | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlSeconds: number): void {
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export const DigestKeys = {
  warmup: (id: number) => `digest:warmup:${id}`,
  warmupQuota: (id: number) => `digest:warmup_quota:${id}`,
  next: (id: number) => `digest:next:${id}`,
  lock: (id: number) => `digest:lock:${id}`,
  prefs: (id: number) => `digest:prefs:${id}`
};

const PREFS_CACHE_TTL_SEC = 5 * 60;

async function get(key: string): Promise<string | null> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      return await redis.get(key);
    } catch {
      /* fall through */
    }
  }
  return memGet(key);
}

async function set(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      await redis.set(key, value, 'EX', ttlSeconds);
      return;
    } catch {
      /* fall through */
    }
  }
  memSet(key, value, ttlSeconds);
}

async function del(...keys: string[]): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      await redis.del(...keys);
    } catch {
      /* ignore */
    }
  }
  for (const key of keys) memory.delete(key);
}

/** Atomic-ish "only one sender wins" lock. Falls back to a memory check. */
async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      const ok = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return ok === 'OK';
    } catch {
      /* fall through */
    }
  }
  if (memGet(key)) return false;
  memSet(key, '1', ttlSeconds);
  return true;
}

async function incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, ttlSeconds);
      return n;
    } catch {
      /* fall through */
    }
  }
  const current = parseInt(memGet(key) || '0', 10) || 0;
  const next = current + 1;
  memSet(key, String(next), ttlSeconds);
  return next;
}

export class DigestSchedule {
  static async getWarmupDueAt(telegramId: number): Promise<number | null> {
    const raw = await get(DigestKeys.warmup(telegramId));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  static async setWarmup(telegramId: number, dueAtMs: number): Promise<void> {
    const ttl = Math.max(60, Math.ceil((dueAtMs - Date.now()) / 1000) + 3600);
    await set(DigestKeys.warmup(telegramId), String(dueAtMs), ttl);
  }

  static async clearWarmup(telegramId: number): Promise<void> {
    await del(DigestKeys.warmup(telegramId));
  }

  /** Returns the number of warmups used in the rolling 24h window after counting this one. */
  static async consumeWarmupQuota(telegramId: number): Promise<number> {
    return incrWithTtl(DigestKeys.warmupQuota(telegramId), 24 * 60 * 60);
  }

  static async warmupQuotaUsed(telegramId: number): Promise<number> {
    const raw = await get(DigestKeys.warmupQuota(telegramId));
    return parseInt(raw || '0', 10) || 0;
  }

  static async getNextRegularAt(telegramId: number): Promise<number | null> {
    const raw = await get(DigestKeys.next(telegramId));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  static async setNextRegularAt(telegramId: number, atMs: number): Promise<void> {
    const ttl = Math.max(300, Math.ceil((atMs - Date.now()) / 1000) + 7 * 24 * 3600);
    await set(DigestKeys.next(telegramId), String(atMs), ttl);
  }

  static async acquireSendLock(telegramId: number, ttlSeconds = 90): Promise<boolean> {
    return acquireLock(DigestKeys.lock(telegramId), ttlSeconds);
  }

  /** Wipes every scheduling key for a user (VIP ended, account deleted, queue cleared). */
  static async reset(telegramId: number): Promise<void> {
    await del(
      DigestKeys.warmup(telegramId),
      DigestKeys.next(telegramId),
      DigestKeys.lock(telegramId),
      DigestKeys.prefs(telegramId)
    );
  }

  static async invalidatePrefsCache(telegramId: number): Promise<void> {
    await del(DigestKeys.prefs(telegramId));
  }
}

// ── Per-user delivery prefs ───────────────────────────────────────────────

export interface DigestPrefs {
  days: number[]; // ISO 1=Mon … 7=Sun
  startHour: number; // inclusive
  endHour: number; // exclusive
  intervalH: number; // 1|2|3|4
  paused: boolean;
}

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAYS_ONLY = [1, 2, 3, 4, 5] as const;

export function hardStartHour(): number {
  return clampHourEnv(process.env.NOTIF_HARD_START_HOUR, 7);
}

export function hardEndHour(): number {
  return clampHourEnv(process.env.NOTIF_HARD_END_HOUR, 23);
}

/**
 * Allowed clock hours for /schedule (Europe/Madrid).
 * Start = morning 07–12 only. End = evening 19–23 only (must be after start).
 */
export const SCHEDULE_START_HOURS = [7, 8, 9, 10, 11, 12] as const;
export const SCHEDULE_END_HOURS = [19, 20, 21, 22, 23] as const;

export function allowedEndHoursAfter(startHour: number): number[] {
  return SCHEDULE_END_HOURS.filter((h) => h > startHour);
}

function snapToAllowed(hour: number, allowed: readonly number[]): number {
  if (allowed.includes(hour as (typeof allowed)[number])) return hour;
  let best = allowed[0]!;
  let bestDist = Math.abs(best - hour);
  for (const h of allowed) {
    const d = Math.abs(h - hour);
    if (d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

/** Defaults for new users / Reset (NOTIF_WINDOW_* + NOTIF_INTERVAL_HOURS). */
export function defaultDigestPrefs(): DigestPrefs {
  const hardStart = hardStartHour();
  const hardEnd = hardEndHour();
  let start = clampHourEnv(process.env.NOTIF_WINDOW_START_HOUR, 8);
  let end = clampHourEnv(process.env.NOTIF_WINDOW_END_HOUR, 21);
  start = snapToAllowed(
    Math.max(hardStart, Math.min(start, hardEnd - 1)),
    SCHEDULE_START_HOURS
  );
  const ends = allowedEndHoursAfter(start);
  end = snapToAllowed(
    Math.max(start + 1, Math.min(end, hardEnd)),
    ends.length ? ends : SCHEDULE_END_HOURS
  );
  if (end <= start) {
    end = ends[0] ?? Math.min(start + 1, hardEnd);
  }
  const intervalRaw = parseInt(process.env.NOTIF_INTERVAL_HOURS || '2', 10);
  const intervalH = [1, 2, 3, 4].includes(intervalRaw) ? intervalRaw : 2;
  return {
    days: [...ALL_WEEKDAYS],
    startHour: start,
    endHour: end,
    intervalH,
    paused: false
  };
}

export function clampSchedulePrefs(raw: Partial<DigestPrefs> | null | undefined): DigestPrefs {
  const defaults = defaultDigestPrefs();
  const hardEnd = hardEndHour();

  let days = Array.isArray(raw?.days)
    ? [...new Set(raw!.days!.map((d) => Math.round(Number(d))).filter((d) => d >= 1 && d <= 7))]
    : defaults.days;
  if (days.length === 0) days = [...ALL_WEEKDAYS];
  days.sort((a, b) => a - b);

  let startHour = Number.isFinite(raw?.startHour) ? Math.round(raw!.startHour!) : defaults.startHour;
  let endHour = Number.isFinite(raw?.endHour) ? Math.round(raw!.endHour!) : defaults.endHour;

  startHour = snapToAllowed(startHour, SCHEDULE_START_HOURS);
  const ends = allowedEndHoursAfter(startHour);
  if (ends.length === 0) {
    // Should not happen with SCHEDULE_START_HOURS max 22
    startHour = 22;
    endHour = 23;
  } else {
    endHour = snapToAllowed(endHour, ends);
    if (endHour <= startHour) {
      endHour = ends[0]!;
    }
    endHour = Math.min(endHour, hardEnd);
  }

  let intervalH = Number.isFinite(raw?.intervalH) ? Math.round(raw!.intervalH!) : defaults.intervalH;
  if (![1, 2, 3, 4].includes(intervalH)) intervalH = defaults.intervalH;

  return {
    days,
    startHour,
    endHour,
    intervalH,
    paused: Boolean(raw?.paused)
  };
}

/** ISO weekday: 1=Mon … 7=Sun (uses local TZ — set TZ=Europe/Madrid in Compose). */
export function isoWeekday(now = new Date()): number {
  const js = now.getDay(); // 0=Sun
  return js === 0 ? 7 : js;
}

export function isUserWithinDeliveryWindow(prefs: DigestPrefs, now = new Date()): boolean {
  if (prefs.paused) return false;
  if (!prefs.days.includes(isoWeekday(now))) return false;
  const hour = now.getHours();
  const { startHour: start, endHour: end } = prefs;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * Next epoch ms when the user's window is open (same instant if already open).
 * Walks forward up to 14 days to find a matching weekday + start hour.
 */
export function nextUserWindowOpening(prefs: DigestPrefs, now = new Date()): number {
  if (!prefs.paused && isUserWithinDeliveryWindow(prefs, now)) return now.getTime();

  const days = prefs.days.length ? prefs.days : [...ALL_WEEKDAYS];
  for (let offset = 0; offset < 14; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(prefs.startHour, 0, 0, 0);
    if (offset === 0 && candidate.getTime() <= now.getTime()) {
      // Already past today's open — try later today only if still before end and day allowed
      if (
        days.includes(isoWeekday(now)) &&
        now.getHours() < prefs.endHour &&
        now.getHours() >= prefs.startHour
      ) {
        return now.getTime();
      }
      continue;
    }
    if (!days.includes(isoWeekday(candidate))) continue;
    if (candidate.getTime() > now.getTime()) return candidate.getTime();
  }

  // Fallback: tomorrow at start
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(prefs.startHour, 0, 0, 0);
  return fallback.getTime();
}

export function prefsFromUserRow(row: {
  digestDays?: number[] | null;
  digestStartHour?: number | null;
  digestEndHour?: number | null;
  digestIntervalH?: number | null;
  digestPaused?: boolean | null;
}): DigestPrefs {
  return clampSchedulePrefs({
    days: row.digestDays ?? undefined,
    startHour: row.digestStartHour ?? undefined,
    endHour: row.digestEndHour ?? undefined,
    intervalH: row.digestIntervalH ?? undefined,
    paused: row.digestPaused ?? false
  });
}

/** Load prefs from Redis cache or Postgres (defaults if user missing). */
export async function loadDigestPrefs(telegramId: number): Promise<DigestPrefs> {
  const cached = await get(DigestKeys.prefs(telegramId));
  if (cached) {
    try {
      return clampSchedulePrefs(JSON.parse(cached) as DigestPrefs);
    } catch {
      /* fall through */
    }
  }

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: {
        digestDays: true,
        digestStartHour: true,
        digestEndHour: true,
        digestIntervalH: true,
        digestPaused: true
      }
    });
    const prefs = user ? prefsFromUserRow(user) : defaultDigestPrefs();
    await set(DigestKeys.prefs(telegramId), JSON.stringify(prefs), PREFS_CACHE_TTL_SEC);
    return prefs;
  } catch {
    return defaultDigestPrefs();
  }
}

export async function saveDigestPrefs(
  telegramId: number,
  prefs: DigestPrefs
): Promise<DigestPrefs> {
  const clamped = clampSchedulePrefs(prefs);
  await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: {
      digestDays: clamped.days,
      digestStartHour: clamped.startHour,
      digestEndHour: clamped.endHour,
      digestIntervalH: clamped.intervalH,
      digestPaused: clamped.paused
    }
  });
  await DigestSchedule.invalidatePrefsCache(telegramId);
  await set(DigestKeys.prefs(telegramId), JSON.stringify(clamped), PREFS_CACHE_TTL_SEC);

  // Pull forward an oversized wait if they shortened the interval (never flood now).
  const now = Date.now();
  const nextAt = await DigestSchedule.getNextRegularAt(telegramId);
  const intervalMs = clamped.intervalH * 60 * 60 * 1000;
  if (nextAt !== null && nextAt > now) {
    const maxWait = now + intervalMs;
    if (nextAt > maxWait) {
      await DigestSchedule.setNextRegularAt(telegramId, maxWait);
    }
  }

  return clamped;
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDigestDays(days: number[]): string {
  const sorted = [...new Set(days.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Mon–Sun';
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return 'Weekdays';
  if (sorted.length === 0) return 'Mon–Sun';
  return sorted.map((d) => DAY_SHORT[d - 1]).join(', ');
}

export function formatHourRange(startHour: number, endHour: number): string {
  const pad = (h: number) => String(h).padStart(2, '0');
  return `${pad(startHour)}:00–${pad(endHour)}:00`;
}

/** Human preview of the next likely send (warmup or regular), pushed into the user window. */
export async function estimateNextSendLabel(
  telegramId: number,
  prefs?: DigestPrefs
): Promise<string> {
  const p = prefs ?? (await loadDigestPrefs(telegramId));
  if (p.paused) return 'Paused';

  const now = Date.now();
  const warmup = await DigestSchedule.getWarmupDueAt(telegramId);
  const nextReg = await DigestSchedule.getNextRegularAt(telegramId);
  let candidate = warmup ?? nextReg ?? now;

  if (candidate < now) candidate = now;

  let at = new Date(candidate);
  if (!isUserWithinDeliveryWindow(p, at)) {
    at = new Date(nextUserWindowOpening(p, at));
  }

  const weekday = DAY_SHORT[isoWeekday(at) - 1];
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `~ ${weekday} ${hh}:${mm}`;
}

/** @deprecated Prefer isUserWithinDeliveryWindow — kept for any legacy callers. */
export function isWithinDeliveryWindow(now = new Date()): boolean {
  const prefs = defaultDigestPrefs();
  return isUserWithinDeliveryWindow({ ...prefs, paused: false }, now);
}

/** @deprecated Prefer nextUserWindowOpening */
export function nextWindowOpening(now = new Date()): number {
  return nextUserWindowOpening(defaultDigestPrefs(), now);
}

function clampHourEnv(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 0 || n > 24) return fallback;
  return n;
}
