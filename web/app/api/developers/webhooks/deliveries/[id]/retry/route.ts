/**
 * Send one of this platform's webhook deliveries again, now. Only one that has
 * not been delivered. No password: sending an event again to the platform's
 * own endpoint changes nothing, and the receiver dedupes by the event id.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../../lib/cookies';
import { getSupabase } from '../../../../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../../../../lib/apiError';
import { platformForAccount } from '../../../../../../../lib/apiPlatforms.ts';
import { retryDelivery } from '../../../../../../../lib/apiWebhooks.ts';

const ROUTE = 'POST /api/developers/webhooks/deliveries/[id]/retry';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params: paramsIn }: { params: Promise<{ id: string }> }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { id } = await paramsIn;
    const db = getSupabase();
    const platform = await platformForAccount(db, accountId);
    if (!platform || !UUID.test(String(id || ''))) return NextResponse.json({ error: 'Delivery not found' }, { status: 404 });
    if (!(await retryDelivery(db, platform.id, id))) return NextResponse.json({ error: 'Delivery not found or already delivered' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
