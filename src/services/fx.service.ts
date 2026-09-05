/**
 * ECB FX rates via Frankfurter (no API key).
 * https://www.frankfurter.app/docs/
 */
import { prisma } from '../db/prisma.js';

const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=EUR';
const META_KEY = 'fx:rates:eur';
const MEMORY_TTL_MS = 60 * 60 * 1000; // 1h

type RatesPayload = {
  base: string;
  date: string;
  rates: Record<string, number>;
  fetchedAt: number;
};

let memoryCache: RatesPayload | null = null;

async function readMetaRates(): Promise<RatesPayload | null> {
  try {
    const row = await prisma.appMeta.findUnique({ where: { key: META_KEY } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as RatesPayload;
    if (!parsed?.rates || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeMetaRates(payload: RatesPayload): Promise<void> {
  try {
    await prisma.appMeta.upsert({
      where: { key: META_KEY },
      create: { key: META_KEY, value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) }
    });
  } catch (err) {
    console.warn('⚠️ [FX] Could not persist rates to AppMeta:', (err as Error).message);
  }
}

async function fetchFrankfurter(): Promise<RatesPayload> {
  const res = await fetch(FRANKFURTER_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    throw new Error(`Frankfurter HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    base?: string;
    date?: string;
    rates?: Record<string, number>;
  };
  if (!data.rates || typeof data.rates !== 'object') {
    throw new Error('Frankfurter payload missing rates');
  }
  return {
    base: data.base || 'EUR',
    date: data.date || new Date().toISOString().slice(0, 10),
    rates: data.rates,
    fetchedAt: Date.now()
  };
}

/** Rates quoted as units of currency per 1 EUR. */
export async function getEurFxRates(forceRefresh = false): Promise<RatesPayload> {
  const now = Date.now();
  if (
    !forceRefresh &&
    memoryCache &&
    now - memoryCache.fetchedAt < MEMORY_TTL_MS
  ) {
    return memoryCache;
  }

  if (!forceRefresh) {
    const fromMeta = await readMetaRates();
    if (fromMeta && now - fromMeta.fetchedAt < MEMORY_TTL_MS) {
      memoryCache = fromMeta;
      return fromMeta;
    }
  }

  try {
    const fresh = await fetchFrankfurter();
    memoryCache = fresh;
    await writeMetaRates(fresh);
    console.log(
      `💱 [FX] Rates refreshed (${fresh.date}, ${Object.keys(fresh.rates).length} currencies).`
    );
    return fresh;
  } catch (err) {
    const fallback = memoryCache || (await readMetaRates());
    if (fallback) {
      console.warn(
        `⚠️ [FX] Live fetch failed (${(err as Error).message}) — using cached rates from ${fallback.date}.`
      );
      memoryCache = fallback;
      return fallback;
    }
    throw err;
  }
}
