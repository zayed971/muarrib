// In-memory per-IP daily page cap — works correctly while a serverless instance stays warm.
// Each cold-start gets its own counter, so the true cap is (cap × warm instances).
// That's acceptable for first testers; swap for Upstash Redis before wider launch.
//
// Override the cap without a deploy: set DAILY_PAGE_CAP in your Vercel env vars.

interface Bucket { count: number; resetAt: number }
const store = new Map<string, Bucket>();

export const DAILY_PAGE_CAP = parseInt(process.env.DAILY_PAGE_CAP ?? '30', 10);

function nextMidnightUtc(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/** Returns allowed=true and increments the counter, or allowed=false when cap is reached. */
export function checkAndIncrement(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  let b = store.get(ip);
  if (!b || now >= b.resetAt) b = { count: 0, resetAt: nextMidnightUtc() };

  if (b.count >= DAILY_PAGE_CAP) {
    store.set(ip, b);
    return { allowed: false, remaining: 0 };
  }
  b.count += 1;
  store.set(ip, b);
  return { allowed: true, remaining: DAILY_PAGE_CAP - b.count };
}
