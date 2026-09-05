import { getRedis, isRedisReady } from '../db/redis.js';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

const memoryStore = new Map<string, MemoryEntry>();
const MAX_MEMORY_ENTRIES = 20_000;

function evictMemoryIfNeeded(): void {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(key);
  }
  if (memoryStore.size <= MAX_MEMORY_ENTRIES) return;
  const overflow = memoryStore.size - MAX_MEMORY_ENTRIES;
  const oldest = [...memoryStore.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, overflow);
  for (const [key] of oldest) memoryStore.delete(key);
}

export async function cacheGet(key: string): Promise<string | null> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      return await redis.get(key);
    } catch {
      // fall through to memory
    }
  }

  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      await redis.set(key, value, 'EX', ttlSeconds);
      return;
    } catch {
      // fall through
    }
  }

  memoryStore.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000
  });
  evictMemoryIfNeeded();
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      await redis.del(...keys);
    } catch {
      // ignore
    }
  }

  for (const key of keys) memoryStore.delete(key);
}

export async function cacheDelByPrefix(prefix: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    } catch {
      // ignore
    }
  }

  for (const key of memoryStore.keys()) {
    if (key.startsWith(prefix)) memoryStore.delete(key);
  }
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const raw = await cacheGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await cacheSet(key, JSON.stringify(value), ttlSeconds);
}

/**
 * Returns cached value or computes + stores it. Concurrent callers share one inflight promise per key (process-local).
 */
const inflight = new Map<string, Promise<unknown>>();

export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  factory: () => Promise<T>
): Promise<T> {
  const cached = await cacheGetJson<T>(key);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await factory();
      if (value !== null && value !== undefined) {
        await cacheSetJson(key, value, ttlSeconds);
      }
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function clearLocalCache(): void {
  memoryStore.clear();
  inflight.clear();
}

/** Cache key helpers */
export const CacheKeys = {
  brands: () => 'inv:brands',
  models: (brandNorm: string) => `inv:models:${brandNorm}`,
  versions: (brandNorm: string, modelNorm: string) => `inv:versions:${brandNorm}:${modelNorm}`,
  ctx: (brandNorm: string, modelNorm: string, tokens: string) =>
    `inv:ctx:${brandNorm}:${modelNorm}:${tokens}`,
  alertsIdx: (brandNorm: string, modelNorm: string) => `alerts:idx:${brandNorm}:${modelNorm}`,
  alertsAny: () => 'alerts:idx:any',
  notifQueue: (telegramId: number) => `notif:q:${telegramId}`,
  invGen: () => 'inv:gen'
};
