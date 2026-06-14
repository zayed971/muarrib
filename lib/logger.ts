/**
 * Minimal structured logging. Emits one JSON line per event so logs are
 * greppable and ready for any sink later (Sentry, Logflare, Axiom, etc.).
 * HARD RULE: never pass image content or API keys into this — only metadata
 * like page number, provider, latency, and error code.
 */

export type LogEvent = 'request' | 'provider_call' | 'success' | 'error' | 'rate_limited';

export function log(event: LogEvent, data: Record<string, unknown> = {}): void {
  const line = { ts: new Date().toISOString(), event, ...data };
  console.log(JSON.stringify(line));
}

/** Short random id to correlate all the log lines of a single request. */
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
