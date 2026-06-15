import { NextRequest, NextResponse } from 'next/server';
import { ensureVerified } from '@/lib/abuse-guard';
import { rateStore } from '@/lib/rate-store';
import { AppError, toApiError } from '@/lib/errors';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'invalid JSON body');
    }

    const token = (rawBody as { token?: unknown })?.token;
    if (typeof token !== 'string') {
      throw new AppError('INVALID_INPUT', 'missing turnstile token');
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

    await ensureVerified(rateStore, ip, token, {
      secret: process.env.TURNSTILE_SECRET ?? '',
      remoteIp: ip,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = toApiError(err);
    return NextResponse.json(body, { status });
  }
}
