import { NextRequest, NextResponse } from 'next/server';
import { callAnthropic } from '@/lib/providers/anthropic';
import { callGemini } from '@/lib/providers/gemini';
import { checkAndIncrement, DAILY_PAGE_CAP } from '@/lib/ratelimit';
import type { Block, Provider } from '@/lib/types';

// Hobby plan cap: 60 s. With Fluid Compute enabled, raise to 300.
export const maxDuration = 60;

const VALID_BLOCK_TYPES = new Set<string>([
  'heading', 'subheading', 'paragraph', 'list',
  'table', 'caption', 'figure', 'equation', 'code',
]);

function stripToJsonArray(text: string): unknown[] {
  let t = text.trim();
  // Strip markdown code fences if the model wrapped the output
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Direct parse
  try { return JSON.parse(t) as unknown[]; } catch { /* fall through to repair */ }

  // Repair: slice from first [ to last ]
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) as unknown[]; } catch { /* fall through */ }
  }

  throw new Error('Could not parse model output as a JSON array');
}

function validateBlocks(raw: unknown[]): Block[] {
  if (!Array.isArray(raw)) throw new Error('Parsed value is not an array');
  return raw.filter(
    (b): b is Block =>
      b !== null &&
      typeof b === 'object' &&
      'type' in b &&
      VALID_BLOCK_TYPES.has((b as Record<string, unknown>).type as string)
  );
}

async function callProvider(
  imageBase64: string,
  pageNum: number,
  provider: Provider,
  apiKey: string,
): Promise<{ text: string; truncated: boolean }> {
  if (provider === 'anthropic') return callAnthropic(imageBase64, pageNum, apiKey);
  return callGemini(imageBase64, pageNum, apiKey);
}

async function translateOnce(
  imageBase64: string,
  pageNum: number,
  provider: Provider,
  apiKey: string,
): Promise<{ blocks: Block[]; truncated: boolean; parseFailed: boolean }> {
  const { text, truncated } = await callProvider(imageBase64, pageNum, provider, apiKey);

  try {
    return { blocks: validateBlocks(stripToJsonArray(text)), truncated, parseFailed: false };
  } catch {
    // Repair failed — signal it instead of burning another full-page call with the
    // same image (likely to fail the same way). The client retries by splitting
    // the page into halves, same as it does for truncation.
    return { blocks: [], truncated, parseFailed: true };
  }
}

function friendlyError(err: unknown): string {
  if (!(err instanceof Error)) return 'Translation failed';
  const m = err.message;
  if (m.includes('[401') || m.includes('401 Unauthorized') || m.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED')) {
    return 'Invalid API key — make sure you pasted a Gemini API key (starts with "AIza"), not an OAuth token or password. Check for extra spaces or newlines.';
  }
  if (m.includes('[403') || m.includes('403 Forbidden')) {
    return 'Access denied — your key may not be enabled for this model. Check your Google AI Studio or Anthropic Console plan.';
  }
  if (m.includes('[429') || m.includes('429 Too Many Requests')) {
    return 'Rate limit hit — the free Gemini tier allows 5 requests/minute. Wait a moment, then use "Retry this page".';
  }
  return m;
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { imageBase64, pageNum, provider } = body;

    if (typeof imageBase64 !== 'string' || !imageBase64) {
      return NextResponse.json({ error: 'Missing or invalid imageBase64' }, { status: 400 });
    }
    if (typeof pageNum !== 'number' || !Number.isInteger(pageNum) || pageNum < 1) {
      return NextResponse.json({ error: 'Missing or invalid pageNum' }, { status: 400 });
    }
    if (provider !== 'anthropic' && provider !== 'gemini') {
      return NextResponse.json(
        { error: 'Invalid provider — must be "anthropic" or "gemini"' },
        { status: 400 }
      );
    }

    const userKeyHeader = req.headers.get('x-user-api-key')?.trim() ?? '';
    const isByok = userKeyHeader.length > 0;
    const apiKey = isByok
      ? userKeyHeader
      : (provider === 'anthropic'
          ? process.env.ANTHROPIC_API_KEY
          : process.env.GEMINI_API_KEY
        )?.trim() ?? '';

    if (!apiKey) {
      return NextResponse.json(
        { error: 'No API key configured. Add your own key in the Advanced section, or ask the site owner to set ANTHROPIC_API_KEY.' },
        { status: 401 }
      );
    }

    if (!isByok) {
      const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
        'unknown';
      const { allowed } = checkAndIncrement(ip);
      if (!allowed) {
        return NextResponse.json(
          {
            error: `You've used all ${DAILY_PAGE_CAP} free pages for today. Add your own API key in the Advanced section to keep translating, or come back tomorrow.`,
            rateLimited: true,
          },
          { status: 429 },
        );
      }
    }

    const { blocks, truncated, parseFailed } = await translateOnce(
      imageBase64,
      pageNum as number,
      provider as Provider,
      apiKey,
    );
    return NextResponse.json({ blocks, truncated, parseFailed });
  } catch (err: unknown) {
    return NextResponse.json({ error: friendlyError(err) }, { status: 502 });
  }
}
