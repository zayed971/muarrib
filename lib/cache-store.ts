import { Redis } from '@upstash/redis';
import { MemoryCache, type CacheStore } from './cache';

/**
 * Singleton CacheStore. Uses Upstash Redis when UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN are configured (production, multi-instance safe);
 * otherwise falls back to an in-memory cache for local dev.
 */
function createStore(): CacheStore {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new MemoryCache();
  }

  const redis = Redis.fromEnv();
  return {
    async get(key) {
      const value = await redis.get<string>(key);
      return value ?? null;
    },
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, { ex: ttlSeconds });
    },
  };
}

export const cacheStore: CacheStore = createStore();
