import { describe, it, expect, vi } from 'vitest';
import { verifyTurnstile } from './turnstile';

describe('verifyTurnstile', () => {
  it('fails fast with missing-token when no token is provided', async () => {
    const result = await verifyTurnstile(undefined, { secret: 's3cret' });
    expect(result).toEqual({ ok: false, reason: 'missing-token' });
  });

  it('fails fast with missing-secret when no secret is configured', async () => {
    const result = await verifyTurnstile('some-token', { secret: '' });
    expect(result).toEqual({ ok: false, reason: 'missing-secret' });
  });

  it('returns ok on a successful Cloudflare response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) }) as unknown as typeof fetch;
    const result = await verifyTurnstile('good-token', { secret: 's3cret', fetchImpl });
    expect(result).toEqual({ ok: true });
  });

  it('returns the joined error codes when Cloudflare reports failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate', 'invalid-input-response'] }),
    }) as unknown as typeof fetch;
    const result = await verifyTurnstile('used-token', { secret: 's3cret', fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'timeout-or-duplicate,invalid-input-response' });
  });

  it('returns network-error when the fetch itself throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch;
    const result = await verifyTurnstile('any-token', { secret: 's3cret', fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'network-error' });
  });

  it('returns bad-response when the response body is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => {
        throw new Error('invalid json');
      },
    }) as unknown as typeof fetch;
    const result = await verifyTurnstile('any-token', { secret: 's3cret', fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'bad-response' });
  });

  it('sends secret, response token, and remoteip in the verification request body', async () => {
    let sentBody: URLSearchParams | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      sentBody = init.body as URLSearchParams;
      return { json: async () => ({ success: true }) };
    }) as unknown as typeof fetch;

    await verifyTurnstile('my-token', { secret: 's3cret', remoteIp: '9.9.9.9', fetchImpl });

    expect(sentBody?.get('secret')).toBe('s3cret');
    expect(sentBody?.get('response')).toBe('my-token');
    expect(sentBody?.get('remoteip')).toBe('9.9.9.9');
  });
});
