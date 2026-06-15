/**
 * Anti-abuse core. Before any paid work, the route enforces:
 *   - ensureVerified: a valid Turnstile check, required once per IP per day
 *     (so a bare script can't hit the endpoint at all).
 *   - enforceLimits, three caps:
 *       • per-IP burst (requests/minute) — stops hammering
 *       • per-IP daily pages          — fair-use cap on the free path
 *       • GLOBAL daily pages          — a circuit-breaker that bounds your TOTAL
 *                                       spend even if a botnet uses 1000 IPs
 *
 * Storage-agnostic: plug a Redis-backed RateStore in production (Upstash);
 * MemoryStore is for local dev and tests.
 *
 * Production store (Upstash Redis):
 *   import { Redis } from '@upstash/redis';
 *   const redis = Redis.fromEnv();
 *   const store: RateStore = {
 *     async incr(key, amount, ttl) {
 *       const n = await redis.incrby(key, amount);
 *       if (n === amount) await redis.expire(key, ttl);
 *       return n;
 *     },
 *     async get(key) { return Number((await redis.get<number>(key)) ?? 0); },
 *     async setFlag(key, ttl) { await redis.set(key, 1, { ex: ttl }); },
 *   };
 */
import { LIMITS } from './config';
import { AppError } from './errors';
import { verifyTurnstile } from './turnstile';

const DAY = 86_400;
const MINUTE = 60;

export interface RateStore {
  /** Increment `key` by `amount`, set TTL on first write, return the new total. */
  incr(key: string, amount: number, windowSeconds: number): Promise<number>;
  /** Current value of `key`, or 0 if absent/expired. */
  get(key: string): Promise<number>;
  /** Mark `key` present for `windowSeconds` (used for the "verified today" flag). */
  setFlag(key: string, windowSeconds: number): Promise<void>;
}

export interface AbuseLimits {
  perIpBurstPerMin: number;
  perIpDailyPages: number;
  globalDailyPages: number;
}

export const ABUSE_LIMITS: AbuseLimits = {
  perIpBurstPerMin: Number(process.env.IP_BURST_PER_MIN ?? 20),
  perIpDailyPages: LIMITS.perIpDailyPages,
  globalDailyPages: Number(process.env.GLOBAL_DAILY_PAGES ?? 5000),
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * Require a passing Turnstile check once per IP per day. After the first pass,
 * the IP is flagged and subsequent requests skip the Cloudflare round-trip.
 * Throws VERIFICATION on failure. Skip this entirely for BYOK users (they pay).
 */
export async function ensureVerified(
  store: RateStore,
  ip: string,
  token: string | undefined,
  opts: { secret: string; remoteIp?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const key = `verified:${ip}:${todayKey()}`;
  if ((await store.get(key)) > 0) return; // already verified today

  const result = await verifyTurnstile(token, {
    secret: opts.secret,
    remoteIp: opts.remoteIp,
    fetchImpl: opts.fetchImpl,
  });
  if (!result.ok) throw new AppError('VERIFICATION', `turnstile: ${result.reason}`);

  await store.setFlag(key, DAY);
}

/** True if this IP already passed Turnstile today. The translate route calls this
 *  and returns VERIFICATION if false, so a script can't skip the /api/verify step. */
export async function isVerified(store: RateStore, ip: string): Promise<boolean> {
  return (await store.get(`verified:${ip}:${todayKey()}`)) > 0;
}

/** Throws RATE_LIMITED if any cap is exceeded; otherwise returns void. */
export async function enforceLimits(
  store: RateStore,
  ip: string,
  pages = 1,
  limits: Partial<AbuseLimits> = {},
): Promise<void> {
  const L: AbuseLimits = { ...ABUSE_LIMITS, ...limits };
  const day = todayKey();

  const burst = await store.incr(`burst:${ip}:${Math.floor(Date.now() / 60_000)}`, 1, MINUTE);
  if (burst > L.perIpBurstPerMin) throw new AppError('RATE_LIMITED', 'ip burst');

  const ipDaily = await store.incr(`ipday:${ip}:${day}`, pages, DAY);
  if (ipDaily > L.perIpDailyPages) throw new AppError('RATE_LIMITED', 'ip daily');

  const global = await store.incr(`globalday:${day}`, pages, DAY);
  if (global > L.globalDailyPages) throw new AppError('RATE_LIMITED', 'global daily');
}

/** In-memory store for local dev and tests. NOT for multi-instance production. */
export class MemoryStore implements RateStore {
  private counters = new Map<string, { count: number; expires: number }>();

  async incr(key: string, amount: number, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const e = this.counters.get(key);
    if (!e || e.expires < now) {
      this.counters.set(key, { count: amount, expires: now + windowSeconds * 1000 });
      return amount;
    }
    e.count += amount;
    return e.count;
  }

  async get(key: string): Promise<number> {
    const e = this.counters.get(key);
    if (!e || e.expires < Date.now()) return 0;
    return e.count;
  }

  async setFlag(key: string, windowSeconds: number): Promise<void> {
    this.counters.set(key, { count: 1, expires: Date.now() + windowSeconds * 1000 });
  }
}
