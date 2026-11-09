/**
 * Add a webhook endpoint for this account's approved platform. Takes the
 * account password: the endpoint receives every payout event it asks for. The
 * secret that signs them is in this response and nowhere else, ever.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { platformForAccount } from '../../../../lib/apiPlatforms.ts';
import { createEndpoint, WebhookRequestError } from '../../../../lib/apiWebhooks.ts';

const ROUTE = 'POST /api/developers/webhooks';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const db = getSupabase();
    const auth = await requirePassword(db, accountId, String(body.password || ''), 'add a webhook endpoint');
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    if (!platform.enabled) return NextResponse.json({ error: 'This platform is paused by Flizy.' }, { status: 403 });

    const made = await createEndpoint(db, platform, { url: body.url, label: body.label, events: body.events });
    return NextResponse.json({ endpoint: made.endpoint, secret: made.secret }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof WebhookRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
