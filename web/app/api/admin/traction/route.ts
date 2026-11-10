/**
 * GET /api/admin/traction: the weekly traction metrics as CSV, for Flizy admins
 * only (accounts.is_admin, checked on the server). ?exclude=0 includes the
 * test and team accounts; the default leaves them out. Counts only.
 * Anyone else gets the same 404 as a route that does not exist.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { isAdminAccount } from '../../../../lib/admin.ts';
import { loadTractionInput } from '../../../../lib/tractionData.ts';
import { computeTraction, tractionCsv } from '../../../../lib/traction.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const db = getSupabase();
    if (!(await isAdminAccount(db, await getAccountIdFromCookie()))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const exclude = new URL(req.url).searchParams.get('exclude') !== '0';
    const result = computeTraction(await loadTractionInput(db), { exclude });
    return new NextResponse(tractionCsv(result), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flizy-traction-${exclude ? 'excluding-team' : 'all'}.csv"`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/admin/traction', err), { status: 500 });
  }
}
