/**
 * Global Bright Data budget (hard cap <= ~$7/mo target) shared via Redis.
 * Split pools: URL verify (tight) vs scraper saves (smaller).
 */
import { getRedis, initRedis } from '../db/redis.js';
import { isBrightDataEnabled } from '../utils/secrets.js';

export type BrightDataPurpose = 'urlverify' | 'scraper';

export function getBrightDataDailyMax(): number {
  return Math.max(
    1,
    parseInt(process.env.BRIGHT_DATA_DAILY_MAX || '11', 10) || 11
  );
}

function getPurposeMax(purpose: BrightDataPurpose): number {
  if (purpose === 'urlverify') {
    return Math.max(
      1,
      parseInt(process.env.URL_VERIFY_PROXY_DAILY_MAX || '7', 10) || 7
    );
  }
  return Math.max(
    1,
    parseInt(process.env.SCRAPER_PROXY_DAILY_MAX || '4', 10) || 4
  );
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function globalKey(): string {
  return `brightdata:uses:total:${todayKey()}`;
}

function purposeKey(purpose: BrightDataPurpose): string {
  return `brightdata:uses:${purpose}:${todayKey()}`;
}

async function readCount(key: string): Promise<number> {
  const redis = getRedis() ?? (await initRedis());
  if (!redis) return 0;
  const raw = await redis.get(key);
  return parseInt(raw || '0', 10) || 0;
}

export async function getBrightDataBudgetStatus(
  purpose?: BrightDataPurpose
): Promise<{
  globalUses: number;
  globalMax: number;
  globalRemaining: number;
  purposeUses?: number;
  purposeMax?: number;
  purposeRemaining?: number;
}> {
  const globalMax = getBrightDataDailyMax();
  const globalUses = await readCount(globalKey());
  const base = {
    globalUses,
    globalMax,
    globalRemaining: Math.max(0, globalMax - globalUses)
  };
  if (!purpose) return base;
  const purposeMax = getPurposeMax(purpose);
  const purposeUses = await readCount(purposeKey(purpose));
  return {
    ...base,
    purposeUses,
    purposeMax,
    purposeRemaining: Math.max(0, purposeMax - purposeUses)
  };
}

export async function canUseBrightData(
  purpose: BrightDataPurpose
): Promise<boolean> {
  if (!isBrightDataEnabled()) return false;
  const s = await getBrightDataBudgetStatus(purpose);
  return s.globalRemaining > 0 && (s.purposeRemaining ?? 0) > 0;
}

/**
 * Consume one Bright Data slot for `purpose`. Returns false if disabled or capped.
 */
export async function tryConsumeBrightDataBudget(
  purpose: BrightDataPurpose
): Promise<boolean> {
  if (!isBrightDataEnabled()) return false;

  const globalMax = getBrightDataDailyMax();
  const purposeMax = getPurposeMax(purpose);
  const redis = getRedis() ?? (await initRedis());

  if (!redis) {
    console.warn('💸 [BrightData] Redis unavailable — skip proxy (budget not tracked)');
    return false;
  }

  const gKey = globalKey();
  const pKey = purposeKey(purpose);

  const globalUses = await redis.incr(gKey);
  if (globalUses === 1) await redis.expire(gKey, 172800);

  if (globalUses > globalMax) {
    await redis.decr(gKey);
    console.warn(
      `💸 [BrightData] Global daily cap (${globalMax}) reached — defer to tomorrow`
    );
    return false;
  }

  const purposeUses = await redis.incr(pKey);
  if (purposeUses === 1) await redis.expire(pKey, 172800);

  if (purposeUses > purposeMax) {
    await redis.decr(gKey);
    await redis.decr(pKey);
    console.warn(
      `💸 [BrightData] ${purpose} cap (${purposeMax}/day) reached — defer to tomorrow`
    );
    return false;
  }

  return true;
}
