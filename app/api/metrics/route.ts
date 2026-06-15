import { NextRequest, NextResponse } from 'next/server';
import { snapshot } from '@/lib/metrics';
import { metricsStore } from '@/lib/metrics-store';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const [all, today] = await Promise.all([snapshot(metricsStore, 'all'), snapshot(metricsStore, 'today')]);
  return NextResponse.json({ all, today });
}
