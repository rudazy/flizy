/**
 * Remove a site checkouts may send the payer back to. Takes the account
 * password. Checkouts already made keep the return link they were given.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { requirePassword } from '../../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../../lib/apiError';
import { platformForAccount } from '../../../../../lib/apiPlatforms.ts';
import { removeOrigin } from '../../../../../lib/apiPayments.ts';

const ROUTE = 'POST /api/developers/origins/remove';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const db = getSupabase();
    const auth = await requirePassword(db, accountId, String(body.password || ''), 'remove a site for checkouts');
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    if (!(await removeOrigin(db, platform.id, body.origin))) return NextResponse.json({ error: 'Site not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
