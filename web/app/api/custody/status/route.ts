/**
 * GET /api/custody/status: how far the signed-in account is through securing
 * its wallet. Accounts outside the pilot get { pilot: false } and nothing else.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { custodyStatus } from '../../../../lib/custody/ceremony.ts';
import { liveCeremonyDeps } from '../../../../lib/custody/liveDeps.ts';

const ROUTE = 'GET /api/custody/status';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const supabase = getSupabase();
    return NextResponse.json(await custodyStatus(supabase, accountId, liveCeremonyDeps(supabase)), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
