/**
 * Translation cache — the cost-killer.
 *
 * Academic papers are SHARED: the same page gets uploaded by hundreds of
 * different students. We fingerprint each page image (SHA-256) and cache its
 * translation. A page that's already been translated is served for free, with
 * no model call. At any real scale, cost for popular content collapses toward
 * zero — which is what makes a free public tool sustainable.
 *
 * Privacy model: the key is an opaque hash of the image. You cannot reverse it
 * to the document, and only someone holding the *identical* source could ever
 * retrieve its translation (and they already have that source). Fine for
 * published papers; confidential/BYOK users can bypass the cache (see opts).
 */
import crypto from 'node:crypto';

/** Bump this whenever the translation prompt changes, so old results aren't reused. */
export const CACHE_PROMPT_VERSION = 'v1';

const DEFAULT_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 60 * 60 * 24 * 30); // 30 days

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Stable fingerprint of a page image (base64 in → sha256 hex out). */
export function imageHash(imageBase64: string): string {
  const comma = imageBase64.indexOf(',');
  const clean = comma !== -1 ? imageBase64.slice(comma + 1) : imageBase64;
  return crypto.createHash('sha256').update(clean.replace(/\s+/g, '')).digest('hex');
}

/** Cache key namespaced by prompt version + provider + model, so changing any of
 *  them never serves a stale result. */
export function cacheKey(provider: string, model: string, hash: string): string {
  return `tr:${CACHE_PROMPT_VERSION}:${provider}:${model}:${hash}`;
}

export interface CacheResult<T> {
  value: T;
  cached: boolean;
}

export interface CacheOptions<T> {
  ttlSeconds?: number;
  /** Only cache when this returns true (e.g. skip truncated/failed pages). */
  shouldCache?: (value: T) => boolean;
  /** Set true for confidential/BYOK requests to skip the cache entirely. */
  bypass?: boolean;
}

/**
 * Return a cached translation for this exact page+provider+model if present;
 * otherwise run `translate`, cache the result, and return it. Cache failures
 * NEVER block a translation — they fall through to a live call.
 */
export async function getCachedOrTranslate<T>(
  store: CacheStore,
  params: { imageBase64: string; provider: string; model: string },
  translate: () => Promise<T>,
  opts: CacheOptions<T> = {},
): Promise<CacheResult<T>> {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const key = cacheKey(params.provider, params.model, imageHash(params.imageBase64));

  if (!opts.bypass) {
    try {
      const hit = await store.get(key);
      if (hit !== null) return { value: JSON.parse(hit) as T, cached: true };
    } catch {
      // cache read failure → fall through to a live translation
    }
  }

  const value = await translate();

  const allowed = opts.shouldCache ? opts.shouldCache(value) : true;
  if (!opts.bypass && allowed) {
    try {
      await store.set(key, JSON.stringify(value), ttl);
    } catch {
      // cache write failure is non-fatal
    }
  }

  return { value, cached: false };
}

/** In-memory cache for local dev and tests. NOT shared across instances. */
export class MemoryCache implements CacheStore {
  private m = new Map<string, { value: string; expires: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.m.get(key);
    if (!e || e.expires < Date.now()) return null;
    return e.value;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.m.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
}
