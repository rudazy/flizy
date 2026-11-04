/**
 * Revoke one of this platform's API keys, immediately. Takes the account
 * password. Other keys keep working. Mailed to the owner.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { getSupabase } from '../../../../../../lib/supabase';
import { requirePassword } from '../../../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../../../lib/apiError';
import { mailKeyEvents, platformForAccount, revokeKey } from '../../../../../../lib/apiPlatforms.ts';
import { mailOwner } from '../../../../../../lib/securityNotice';
import { siteOrigin } from '../../../../../../lib/siteOrigin';

const ROUTE = 'POST /api/developers/keys/[id]/revoke';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params: paramsIn }: { params: Promise<{ id: string }> }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { id } = await paramsIn;
    const body = await req.json().catch(() => ({}));
    const db = getSupabase();
    const auth = await requirePassword(db, accountId, String(body.password || ''), 'revoke an API key');
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const platform = await platformForAccount(db, accountId);
    if (!platform || !UUID.test(String(id || ''))) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
    const done = await revokeKey(db, platform, id);
    if (!done) return NextResponse.json({ error: 'Key not found or already revoked' }, { status: 404 });
    await mailKeyEvents(db, (aid, mail) => mailOwner(db, aid, mail), siteOrigin(), { platformId: platform.id }).catch(() => 0);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
