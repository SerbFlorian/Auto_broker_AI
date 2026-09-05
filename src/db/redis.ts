import { Redis } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

let redis: RedisClient | null = null;
let redisReady = false;

/**
 * Initializes the shared Redis client. Safe to call multiple times.
 * Returns null if REDIS_URL is missing or connection fails (caller should degrade).
 */
export async function initRedis(): Promise<RedisClient | null> {
  if (redis && redisReady) return redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('⚠️ REDIS_URL not set — using in-memory cache fallback.');
    return null;
  }

  try {
    if (!redis) {
      redis = new Redis(url, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: 5000,
        retryStrategy(times: number) {
          if (times > 5) return null;
          return Math.min(times * 200, 2000);
        }
      });

      redis.on('error', (err: Error) => {
        redisReady = false;
        console.error('❌ [Redis] Error:', err.message);
      });

      redis.on('ready', () => {
        redisReady = true;
        console.log('⚡ [Redis] Ready.');
      });

      redis.on('end', () => {
        redisReady = false;
      });
    }

    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect();
    }

    await redis.ping();
    redisReady = true;
    console.log('⚡ [Redis] Connected.');
    return redis;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ [Redis] Unavailable (${message}) — using in-memory fallback.`);
    redisReady = false;
    return null;
  }
}

export function getRedis(): RedisClient | null {
  return redisReady ? redis : null;
}

export function isRedisReady(): boolean {
  return redisReady && redis !== null;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    redis = null;
    redisReady = false;
  }
}
