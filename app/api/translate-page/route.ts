import { NextRequest, NextResponse } from 'next/server';
import { anthropicProvider } from '@/lib/providers/anthropic';
import { geminiProvider } from '@/lib/providers/gemini';
import type { TranslationProvider } from '@/lib/providers/types';
import { reliableCall } from '@/lib/reliable-call';
import { isVerified, enforceLimits } from '@/lib/abuse-guard';
import { rateStore } from '@/lib/rate-store';
import { getCachedOrTranslate } from '@/lib/cache';
import { cacheStore } from '@/lib/cache-store';
import { recordTranslation, recordError } from '@/lib/metrics';
import { metricsStore } from '@/lib/metrics-store';
import { LIMITS, MODELS, serverKey } from '@/lib/config';
import { TranslateRequestSchema, parseModelText, type SchemaBlock } from '@/lib/schema';
import { validateImageBase64 } from '@/lib/validate-image';
import { AppError, toApiError } from '@/lib/errors';
import { log, newRequestId } from '@/lib/logger';
import type { Provider } from '@/lib/types';

// Hobby plan cap: 60 s. With Fluid Compute enabled, raise to 300.
export const maxDuration = 60;

const PROVIDER_ADAPTERS: Record<Provider, TranslationProvider> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

async function translateOnce(
  imageBase64: string,
  pageNum: number,
  provider: Provider,
  apiKey: string,
): Promise<{ blocks: SchemaBlock[]; truncated: boolean; parseFailed: boolean }> {
  const adapter = PROVIDER_ADAPTERS[provider];
  const input = { imageBase64, pageNum, apiKey, model: MODELS[provider].default };
  const { text, truncated } = await reliableCall(() => adapter.translate(input));

  try {
    return { blocks: parseModelText(text), truncated, parseFailed: false };
  } catch {
    // Repair failed — signal it instead of burning another full-page call with the
    // same image (likely to fail the same way). The client retries by splitting
    // the page into halves, same as it does for truncation.
    return { blocks: [], truncated, parseFailed: true };
  }
}

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const startedAt = Date.now();
  let provider: Provider | undefined;
  let pageNum: number | undefined;

  try {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'invalid JSON body');
    }

    const parsed = TranslateRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError('INVALID_INPUT', parsed.error.message);
    }

    provider = parsed.data.provider;
    pageNum = parsed.data.pageNum;
    const imageBase64 = validateImageBase64(parsed.data.imageBase64);

    if (pageNum > LIMITS.maxPagesPerJob) {
      throw new AppError('INVALID_INPUT', `pageNum ${pageNum} exceeds maxPagesPerJob (${LIMITS.maxPagesPerJob})`);
    }

    const userKeyHeader = req.headers.get('x-user-api-key')?.trim() ?? '';
    const isByok = userKeyHeader.length > 0;
    const apiKey = isByok ? userKeyHeader : serverKey[provider]();

    log('request', { requestId, provider, pageNum, byok: isByok });

    if (!apiKey) {
      throw new AppError('PROVIDER_AUTH', 'no API key configured for provider');
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

    if (!isByok && !(await isVerified(rateStore, ip))) {
      throw new AppError('VERIFICATION', 'turnstile verification required');
    }

    try {
      await enforceLimits(rateStore, ip, 1);
    } catch (err) {
      log('rate_limited', { requestId, provider, pageNum });
      throw err;
    }

    // BYOK requests may be confidential — never cache or serve cached results for them.
    const { value, cached } = await getCachedOrTranslate(
      cacheStore,
      { imageBase64, provider: parsed.data.provider, model: MODELS[parsed.data.provider].default },
      () => translateOnce(imageBase64, parsed.data.pageNum, parsed.data.provider, apiKey),
      {
        bypass: isByok,
        shouldCache: (v) => !v.truncated && !v.parseFailed && v.blocks.length > 0,
      },
    );
    const { blocks, truncated, parseFailed } = value;

    try {
      await recordTranslation(metricsStore, { provider: parsed.data.provider, model: MODELS[parsed.data.provider].default, cached });
    } catch {
      // metrics are best-effort — never fail a translation over them
    }

    log('success', {
      requestId,
      provider,
      pageNum,
      model: MODELS[provider].default,
      truncated,
      parseFailed,
      cached,
      blockCount: blocks.length,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ blocks, truncated, parseFailed });
  } catch (err) {
    const { status, body } = toApiError(err);

    try {
      await recordError(metricsStore, body.code);
    } catch {
      // metrics are best-effort — never fail a translation over them
    }

    log('error', {
      requestId,
      provider,
      pageNum,
      code: body.code,
      durationMs: Date.now() - startedAt,
      detail: err instanceof AppError ? err.detail : err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(body, { status });
  }
}
