/**
 * Reliability layer. Wraps any provider call with:
 *   - a TIMEOUT guard, so a hung call fails as a clean TIMEOUT in seconds
 *     instead of hanging until Vercel kills the whole function, and
 *   - bounded retries for TRANSIENT failures (overloaded 503, rate-limited 429,
 *     timeout), respecting a server-suggested "retry in Ns" when given.
 * It FAILS FAST (no retry) on auth/blocked/invalid — retrying those just wastes
 * time and money. Total elapsed time is capped so we never blow the function window.
 */
import { AppError, classifyProviderError, type ErrorCode } from './errors';

const DEFAULT_TIMEOUT_MS = 55_000; // under Vercel's 60s window
const MAX_TOTAL_MS = 58_000; // hard ceiling across all attempts
const TRANSIENT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PROVIDER_OVERLOADED',
  'RATE_LIMITED',
  'TIMEOUT',
]);

/** Reject if `promise` doesn't settle within `ms`, with a clean TIMEOUT error. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('TIMEOUT', `call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Pull a server-suggested retry delay (ms) out of an error detail, else fallback. */
export function retryAfterMs(detail: string | undefined, fallback = 1500): number {
  if (!detail) return fallback;
  const m = detail.match(/retry(?:\s*in|delay)[":\s]*([0-9]+(?:\.[0-9]+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : fallback;
}

export interface ReliableOptions {
  perCallTimeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxTotalMs?: number;
}

/**
 * Run `fn` with timeout + bounded retry. Any raw provider error is normalized
 * through classifyProviderError, so callers always receive a typed AppError.
 */
export async function reliableCall<T>(fn: () => Promise<T>, opts: ReliableOptions = {}): Promise<T> {
  const perCall = opts.perCallTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const baseBackoff = opts.baseBackoffMs ?? 800;
  const maxTotal = opts.maxTotalMs ?? MAX_TOTAL_MS;
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    try {
      // Promise.resolve().then(fn) turns a synchronous throw into a rejection.
      return await withTimeout(Promise.resolve().then(fn), perCall);
    } catch (raw) {
      const err = raw instanceof AppError ? raw : classifyProviderError(raw);

      if (!TRANSIENT.has(err.code) || attempt >= maxRetries) throw err;

      const backoff =
        err.code === 'RATE_LIMITED' ? retryAfterMs(err.detail, baseBackoff) : baseBackoff * 2 ** attempt;
      const wait = Math.min(backoff, 20_000);

      // Don't start a wait we don't have time to finish inside the function window.
      if (Date.now() - startedAt + wait + 1500 > maxTotal) throw err;

      await sleep(wait);
      attempt++;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
