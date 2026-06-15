import { Redis } from '@upstash/redis';
import { MemoryStore, type RateStore } from './abuse-guard';

/**
 * Singleton RateStore. Uses Upstash Redis when UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN are configured (production, multi-instance safe);
 * otherwise falls back to an in-memory store for local dev.
 */
function createStore(): RateStore {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new MemoryStore();
  }

  const redis = Redis.fromEnv();
  return {
    async incr(key, amount, windowSeconds) {
      const n = await redis.incrby(key, amount);
      if (n === amount) await redis.expire(key, windowSeconds);
      return n;
    },
    async get(key) {
      return Number((await redis.get<number>(key)) ?? 0);
    },
    async setFlag(key, windowSeconds) {
      await redis.set(key, 1, { ex: windowSeconds });
    },
  };
}

export const rateStore: RateStore = createStore();
