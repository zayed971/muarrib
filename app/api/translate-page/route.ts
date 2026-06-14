import { NextRequest, NextResponse } from 'next/server';
import { callAnthropic } from '@/lib/providers/anthropic';
import { callGemini } from '@/lib/providers/gemini';
import { checkAndIncrement, DAILY_PAGE_CAP } from '@/lib/ratelimit';
import { LIMITS, MODELS, serverKey } from '@/lib/config';
import { TranslateRequestSchema, parseModelText, type SchemaBlock } from '@/lib/schema';
import { validateImageBase64 } from '@/lib/validate-image';
import { AppError, classifyProviderError, toApiError } from '@/lib/errors';
import { log, newRequestId } from '@/lib/logger';
import type { Provider } from '@/lib/types';

// Hobby plan cap: 60 s. With Fluid Compute enabled, raise to 300.
export const maxDuration = 60;

async function callProvider(
  imageBase64: string,
  pageNum: number,
  provider: Provider,
  apiKey: string,
): Promise<{ text: string; truncated: boolean }> {
  try {
    if (provider === 'anthropic') return await callAnthropic(imageBase64, pageNum, apiKey);
    return await callGemini(imageBase64, pageNum, apiKey);
  } catch (err) {
    throw classifyProviderError(err);
  }
}

async function translateOnce(
  imageBase64: string,
  pageNum: number,
  provider: Provider,
  apiKey: string,
): Promise<{ blocks: SchemaBlock[]; truncated: boolean; parseFailed: boolean }> {
  const { text, truncated } = await callProvider(imageBase64, pageNum, provider, apiKey);

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

    if (!isByok) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
      const { allowed } = checkAndIncrement(ip);
      if (!allowed) {
        log('rate_limited', { requestId, provider, pageNum });
        throw new AppError('RATE_LIMITED', `daily cap (${DAILY_PAGE_CAP}) reached`);
      }
    }

    const { blocks, truncated, parseFailed } = await translateOnce(imageBase64, pageNum, provider, apiKey);

    log('success', {
      requestId,
      provider,
      pageNum,
      model: MODELS[provider].default,
      truncated,
      parseFailed,
      blockCount: blocks.length,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ blocks, truncated, parseFailed });
  } catch (err) {
    const { status, body } = toApiError(err);
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
