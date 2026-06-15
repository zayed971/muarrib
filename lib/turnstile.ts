/**
 * Cloudflare Turnstile verification. The browser solves an invisible challenge
 * and sends a token; we verify it server-side BEFORE doing any paid work. This
 * is the single biggest defense against scripts/bots draining your AI budget,
 * because a bare HTTP client can't pass it.
 *
 * Get a free widget (site key + secret key) in the Cloudflare dashboard.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface VerifyOptions {
  secret: string;
  remoteIp?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifyTurnstile(token: string | undefined, opts: VerifyOptions): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: 'missing-token' };
  if (!opts.secret) return { ok: false, reason: 'missing-secret' };

  const doFetch = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({ secret: opts.secret, response: token });
  if (opts.remoteIp) body.set('remoteip', opts.remoteIp);

  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? SITEVERIFY, { method: 'POST', body });
  } catch {
    return { ok: false, reason: 'network-error' };
  }

  let data: { success?: boolean; 'error-codes'?: string[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, reason: 'bad-response' };
  }

  if (data.success === true) return { ok: true };
  return { ok: false, reason: (data['error-codes'] ?? ['failed']).join(',') };
}
