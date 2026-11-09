/**
 * Remove one of this platform's webhook endpoints, immediately; deliveries
 * still waiting for it are dropped. Takes the account password.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { getSupabase } from '../../../../../../lib/supabase';
import { requirePassword } from '../../../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../../../lib/apiError';
import { platformForAccount } from '../../../../../../lib/apiPlatforms.ts';
import { deleteEndpoint } from '../../../../../../lib/apiWebhooks.ts';

const ROUTE = 'POST /api/developers/webhooks/[id]/delete';
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
    const auth = await requirePassword(db, accountId, String(body.password || ''), 'remove a webhook endpoint');
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const platform = await platformForAccount(db, accountId);
    if (!platform || !UUID.test(String(id || ''))) return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 });
    if (!(await deleteEndpoint(db, platform, id))) return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
