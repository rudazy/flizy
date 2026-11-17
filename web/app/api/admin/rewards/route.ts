/**
 * GET /api/admin/rewards: the weekly fees and rewards as CSV, for Flizy admins
 * only (accounts.is_admin, checked on the server). ?exclude=0 includes the
 * test and team accounts; the default leaves them out. Amounts and counts only.
 * Anyone else gets the same 404 as a route that does not exist.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { isAdminAccount } from '../../../../lib/admin.ts';
import { loadRewardsAdminInput } from '../../../../lib/rewardsAdminData.ts';
import { computeRewardsAdmin, rewardsAdminCsv } from '../../../../lib/rewardsAdmin.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const db = getSupabase();
    if (!(await isAdminAccount(db, await getAccountIdFromCookie()))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const exclude = new URL(req.url).searchParams.get('exclude') !== '0';
    const result = computeRewardsAdmin(await loadRewardsAdminInput(db), { exclude });
    return new NextResponse(rewardsAdminCsv(result), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flizy-rewards-${exclude ? 'excluding-team' : 'all'}.csv"`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/admin/rewards', err), { status: 500 });
  }
}
