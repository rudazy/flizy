/**
 * Register a site a checkout may send the payer back to, for this account's
 * approved platform. Takes the account password: a checkout's return link is
 * accepted only on a registered origin, so this decides where Flizy's
 * checkout page may send people.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { platformForAccount } from '../../../../lib/apiPlatforms.ts';
import { addOrigin, OriginRequestError } from '../../../../lib/apiPayments.ts';

const ROUTE = 'POST /api/developers/origins';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const db = getSupabase();
    const auth = await requirePassword(db, accountId, String(body.password || ''), 'register a site for checkouts');
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    if (!platform.enabled) return NextResponse.json({ error: 'This platform is paused by Flizy.' }, { status: 403 });
    return NextResponse.json({ origin: await addOrigin(db, platform.id, body.origin) });
  } catch (err) {
    if (err instanceof OriginRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
