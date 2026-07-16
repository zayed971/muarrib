import { describe, it, expect, vi } from 'vitest';
import { enforceLimits, ensureVerified, isVerified, MemoryStore } from './abuse-guard';
import { AppError } from './errors';

function fakeFetch(success: boolean) {
  return vi.fn().mockResolvedValue({
    json: async () => (success ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }),
  }) as unknown as typeof fetch;
}

describe('enforceLimits — per-IP burst cap', () => {
  it('allows requests up to the burst cap', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) {
      await expect(
        enforceLimits(store, '1.2.3.4', 1, { perIpBurstPerMin: 3, perIpDailyPages: 999, globalDailyPages: 999 }),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects the request that pushes past the burst cap', async () => {
    const store = new MemoryStore();
    const limits = { perIpBurstPerMin: 3, perIpDailyPages: 999, globalDailyPages: 999 };
    await enforceLimits(store, '1.2.3.4', 1, limits);
    await enforceLimits(store, '1.2.3.4', 1, limits);
    await enforceLimits(store, '1.2.3.4', 1, limits);
    await expect(enforceLimits(store, '1.2.3.4', 1, limits)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'ip burst',
    });
  });

  it('tracks bursts per IP independently', async () => {
    const store = new MemoryStore();
    const limits = { perIpBurstPerMin: 1, perIpDailyPages: 999, globalDailyPages: 999 };
    await enforceLimits(store, '1.1.1.1', 1, limits);
    // a different IP should not be affected by 1.1.1.1's burst count
    await expect(enforceLimits(store, '2.2.2.2', 1, limits)).resolves.toBeUndefined();
  });
});

describe('enforceLimits — per-IP daily page cap', () => {
  it('allows pages exactly up to the daily cap', async () => {
    const store = new MemoryStore();
    const limits = { perIpBurstPerMin: 999, perIpDailyPages: 10, globalDailyPages: 999 };
    await expect(enforceLimits(store, '1.2.3.4', 10, limits)).resolves.toBeUndefined();
  });

  it('rejects once the daily page cap is exceeded', async () => {
    const store = new MemoryStore();
    const limits = { perIpBurstPerMin: 999, perIpDailyPages: 10, globalDailyPages: 999 };
    await enforceLimits(store, '1.2.3.4', 10, limits);
    await expect(enforceLimits(store, '1.2.3.4', 1, limits)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'ip daily',
    });
  });
});

describe('enforceLimits — global daily cap', () => {
  it('is shared across different IPs, not tracked per-IP', async () => {
    const store = new MemoryStore();
    const limits = { perIpBurstPerMin: 999, perIpDailyPages: 999, globalDailyPages: 5 };
    await enforceLimits(store, '1.1.1.1', 3, limits);
    await enforceLimits(store, '2.2.2.2', 2, limits); // brings global total to 5, exactly the cap
    await expect(enforceLimits(store, '3.3.3.3', 1, limits)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'global daily',
    });
  });
});

describe('ensureVerified / isVerified', () => {
  it('throws VERIFICATION when the Turnstile check fails', async () => {
    const store = new MemoryStore();
    await expect(
      ensureVerified(store, '1.2.3.4', 'bad-token', { secret: 's3cret', fetchImpl: fakeFetch(false) }),
    ).rejects.toBeInstanceOf(AppError);
    expect(await isVerified(store, '1.2.3.4')).toBe(false);
  });

  it('marks the IP verified for the day when the Turnstile check passes', async () => {
    const store = new MemoryStore();
    await ensureVerified(store, '1.2.3.4', 'good-token', { secret: 's3cret', fetchImpl: fakeFetch(true) });
    expect(await isVerified(store, '1.2.3.4')).toBe(true);
  });

  it('skips the Turnstile round-trip entirely once already verified today', async () => {
    const store = new MemoryStore();
    await ensureVerified(store, '1.2.3.4', 'good-token', { secret: 's3cret', fetchImpl: fakeFetch(true) });

    const shouldNeverBeCalled = vi.fn();
    await ensureVerified(store, '1.2.3.4', 'irrelevant-token', {
      secret: 's3cret',
      fetchImpl: shouldNeverBeCalled as unknown as typeof fetch,
    });
    expect(shouldNeverBeCalled).not.toHaveBeenCalled();
  });
});
