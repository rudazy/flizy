/**
 * Weekly traction snapshot: computes every completed week's figures, with and
 * without the excluded accounts, and keeps them in metrics_weekly_snapshots
 * (web/lib/tractionSnapshot.ts), so what was reported survives a later change
 * of definition.
 *
 * Not on a schedule by itself. Run it from Vercel Cron by adding it to
 * web/vercel.json, or from any scheduler that can send the bearer token.
 * Callers must send CRON_SECRET as a bearer token, as Vercel Cron does; without
 * CRON_SECRET set the route refuses everyone. The answer is a count only.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody } from '@/lib/apiError';
import { bearerMatches } from '@/lib/bearerSecret';
import { getSupabase } from '@/lib/supabase.ts';
import { loadTractionInput } from '@/lib/tractionData.ts';
import { writeTractionSnapshots } from '@/lib/tractionSnapshot.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: Request) {
  if (!bearerMatches(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  try {
    const db = getSupabase();
    const written = await writeTractionSnapshots(db, await loadTractionInput(db));
    return NextResponse.json({ ok: true, written }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/cron/traction-snapshot', err), { status: 500, headers: NO_STORE });
  }
}
