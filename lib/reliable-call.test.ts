import { describe, it, expect, vi } from 'vitest';
import { reliableCall, retryAfterMs, withTimeout } from './reliable-call';
import { AppError } from './errors';

describe('reliableCall', () => {
  it('succeeds on the first try with no retries', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await reliableCall(fn, { baseBackoffMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds after transient failures, retrying the configured number of times', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError('PROVIDER_OVERLOADED'))
      .mockRejectedValueOnce(new AppError('RATE_LIMITED'))
      .mockResolvedValueOnce('recovered');

    const result = await reliableCall(fn, { maxRetries: 2, baseBackoffMs: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausts retries and throws the last transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError('PROVIDER_OVERLOADED'));

    await expect(reliableCall(fn, { maxRetries: 2, baseBackoffMs: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_OVERLOADED',
    });
    // initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a non-transient error without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError('PROVIDER_AUTH'));

    await expect(reliableCall(fn, { maxRetries: 2, baseBackoffMs: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('times out a hung call as TIMEOUT', async () => {
    const fn = () => new Promise(() => {}); // never resolves
    await expect(
      reliableCall(fn, { perCallTimeoutMs: 20, maxRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('normalizes a raw (non-AppError) provider throw via classifyProviderError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'));
    await expect(reliableCall(fn, { maxRetries: 0 })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('gives up instead of starting a retry wait that would exceed the total time budget', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError('PROVIDER_OVERLOADED'));
    // maxTotalMs is tiny, so even the first backoff can't fit -> should throw immediately
    // instead of sleeping and retrying.
    const start = Date.now();
    await expect(
      reliableCall(fn, { maxRetries: 5, baseBackoffMs: 10_000, maxTotalMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OVERLOADED' });
    expect(Date.now() - start).toBeLessThan(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('retryAfterMs', () => {
  it('parses a server-suggested "retry in Ns" delay', () => {
    expect(retryAfterMs('please retry in 2s')).toBe(2000);
  });

  it('parses a fractional-second delay', () => {
    expect(retryAfterMs('retrydelay: 1.5s')).toBe(1500);
  });

  it('falls back to the default when no delay is present', () => {
    expect(retryAfterMs(undefined, 1500)).toBe(1500);
    expect(retryAfterMs('overloaded, try again later', 1500)).toBe(1500);
  });
});

describe('withTimeout', () => {
  it('resolves normally when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('fast'), 1000)).resolves.toBe('fast');
  });

  it('rejects with a TIMEOUT AppError when the promise never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});
