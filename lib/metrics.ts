/**
 * Metrics — the funding-pitch engine.
 *
 * Tracks the three numbers that make the case for a free public tool:
 *   • pages translated (impact)
 *   • cache hit-rate (why it stays cheap)
 *   • estimated cost (the actual, tiny spend)
 *
 * Counters live in Redis (Upstash) in production; MemoryMetrics is for dev/tests.
 * Recording is best-effort and must never block or fail a translation.
 */
import { MODELS } from './config';

/** Rough USD cost per page, by model. Tune as provider pricing changes. */
export const PAGE_COST_USD: Record<string, number> = {
  [MODELS.anthropic.default]: 0.01, // Haiku ~1¢
  [MODELS.anthropic.highQuality]: 0.03, // Sonnet ~3¢
  [MODELS.gemini.default]: 0.003, // Flash ~0.3¢
};
const FALLBACK_COST = 0.01;

export function pageCost(model: string): number {
  return PAGE_COST_USD[model] ?? FALLBACK_COST;
}

export interface MetricsStore {
  incr(key: string, amount: number): Promise<void>;
  /** Increment several counters in one round-trip (pipelined when backed by Redis). */
  incrMany(deltas: Array<{ key: string; amount: number }>): Promise<void>;
  get(key: string): Promise<number>;
}

const ALL = 'm:all';
function dayNs(date = new Date()): string {
  return `m:${date.toISOString().slice(0, 10)}`; // m:YYYY-MM-DD (UTC)
}

const KNOWN_MODELS = [MODELS.anthropic.default, MODELS.anthropic.highQuality, MODELS.gemini.default];
const KNOWN_PROVIDERS = ['anthropic', 'gemini'];

export interface RecordParams {
  provider: string;
  model: string;
  cached: boolean;
}

/** Record one translated page. Cache hits are counted but cost nothing. */
export async function recordTranslation(store: MetricsStore, p: RecordParams): Promise<void> {
  const day = dayNs();
  const deltas = [
    { key: `${ALL}:pages`, amount: 1 },
    { key: `${day}:pages`, amount: 1 },
    { key: `${ALL}:provider:${p.provider}`, amount: 1 },
  ];
  if (p.cached) {
    deltas.push({ key: `${ALL}:cached`, amount: 1 }, { key: `${day}:cached`, amount: 1 });
  } else {
    deltas.push({ key: `${ALL}:billed:${p.model}`, amount: 1 }, { key: `${day}:billed:${p.model}`, amount: 1 });
  }
  await store.incrMany(deltas);
}

export async function recordError(store: MetricsStore, code: string): Promise<void> {
  await store.incrMany([
    { key: `${ALL}:errors`, amount: 1 },
    { key: `${ALL}:err:${code}`, amount: 1 },
  ]);
}

export interface MetricsSnapshot {
  scope: 'all' | 'today';
  pages: number;
  cached: number;
  cacheHitRate: number; // 0..1
  billedPages: number;
  estimatedCostUsd: number;
  byProvider: Record<string, number>;
  perModelBilled: Record<string, number>;
  errors: number;
}

/** Read a snapshot. `all` = lifetime totals; `today` = current UTC day. */
export async function snapshot(store: MetricsStore, scope: 'all' | 'today' = 'all'): Promise<MetricsSnapshot> {
  const ns = scope === 'all' ? ALL : dayNs();

  const pages = await store.get(`${ns}:pages`);
  const cached = await store.get(`${ns}:cached`);
  const errors = await store.get(`${ALL}:errors`);

  const byProvider: Record<string, number> = {};
  for (const p of KNOWN_PROVIDERS) byProvider[p] = await store.get(`${ALL}:provider:${p}`);

  const perModelBilled: Record<string, number> = {};
  let billedPages = 0;
  let cost = 0;
  for (const m of KNOWN_MODELS) {
    const n = await store.get(`${ns}:billed:${m}`);
    perModelBilled[m] = n;
    billedPages += n;
    cost += n * pageCost(m);
  }

  return {
    scope,
    pages,
    cached,
    cacheHitRate: pages > 0 ? cached / pages : 0,
    billedPages,
    estimatedCostUsd: Math.round(cost * 10000) / 10000,
    byProvider,
    perModelBilled,
    errors,
  };
}

/** In-memory metrics for local dev and tests. NOT shared across instances. */
export class MemoryMetrics implements MetricsStore {
  private m = new Map<string, number>();
  async incr(key: string, amount: number): Promise<void> {
    this.m.set(key, (this.m.get(key) ?? 0) + amount);
  }
  async incrMany(deltas: Array<{ key: string; amount: number }>): Promise<void> {
    for (const d of deltas) await this.incr(d.key, d.amount);
  }
  async get(key: string): Promise<number> {
    return this.m.get(key) ?? 0;
  }
}
