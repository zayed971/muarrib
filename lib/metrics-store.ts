import { Redis } from '@upstash/redis';
import { MemoryMetrics, type MetricsStore } from './metrics';

/**
 * Singleton MetricsStore. Uses Upstash Redis when UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN are configured (production, multi-instance safe);
 * otherwise falls back to an in-memory store for local dev.
 */
function createStore(): MetricsStore {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new MemoryMetrics();
  }

  const redis = Redis.fromEnv();
  return {
    async incr(key, amount) {
      await redis.incrby(key, amount);
    },
    async incrMany(deltas) {
      // Pipeline the increments into one round-trip — Upstash's free tier has
      // per-command quotas, and a translated page can produce several counters.
      const pipeline = redis.pipeline();
      for (const d of deltas) pipeline.incrby(d.key, d.amount);
      await pipeline.exec();
    },
    async get(key) {
      return Number((await redis.get<number>(key)) ?? 0);
    },
  };
}

export const metricsStore: MetricsStore = createStore();
