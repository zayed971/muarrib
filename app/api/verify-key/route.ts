import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ANTHROPIC_MODEL, GEMINI_MODEL } from '@/lib/config';

// Tiny one-token ping per provider — just enough to confirm the key authenticates.
export const maxDuration = 30;

async function pingAnthropic(apiKey: string): Promise<void> {
  const client = new Anthropic({ apiKey });
  await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

async function pingGemini(apiKey: string): Promise<void> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 1 },
  });
}

function friendlyVerifyError(err: unknown): string {
  const status = (err instanceof Error ? err.message : '').match(/\b(401|403|429)\b/)?.[1];
  if (status === '401') return 'Key rejected — double-check it.';
  if (status === '403') return 'Key rejected — it may not have access to this model.';
  if (status === '429') return 'Rate limited while checking — wait a moment and try again.';
  return 'Key rejected — double-check it.';
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ valid: false, error: 'Invalid request' });
    }

    const { provider } = body;
    if (provider !== 'anthropic' && provider !== 'gemini') {
      return NextResponse.json({ valid: false, error: 'Invalid provider' });
    }

    const apiKey = req.headers.get('x-user-api-key')?.trim() ?? '';
    if (!apiKey) {
      return NextResponse.json({ valid: false, error: 'No key supplied' });
    }

    try {
      if (provider === 'anthropic') await pingAnthropic(apiKey);
      else await pingGemini(apiKey);
      return NextResponse.json({ valid: true });
    } catch (err) {
      // Never log key contents — only a derived, generic message reaches the client.
      return NextResponse.json({ valid: false, error: friendlyVerifyError(err) });
    }
  } catch {
    return NextResponse.json({ valid: false, error: 'Verification failed — try again.' });
  }
}
