/**
 * Payment notices for the signed-in account.
 * The list is the bell next to search. Marking one read does not move money.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import {
  allowNoticeMark,
  allowNoticeRead,
  listPaymentNotices,
  markPaymentNotices,
} from '../../../lib/incomingNotice.ts';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { getSupabase } from '../../../lib/supabase';

const ROUTE = 'GET|POST /api/notices';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = 'Payment notices are not available yet.';
const NO_STORE = { 'cache-control': 'private, no-store' };

export const dynamic = 'force-dynamic';

function answered(err: unknown) {
  if (err instanceof Error && err.message === UNAVAILABLE) {
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500, headers: NO_STORE });
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401, headers: NO_STORE });
    if (!allowNoticeRead(accountId)) {
      return NextResponse.json({ error: 'Too many requests. Try again in a while.' }, { status: 429, headers: NO_STORE });
    }
    const notices = await listPaymentNotices(getSupabase(), accountId);
    const unread = notices.reduce((sum, row) => sum + (row.unread ? 1 : 0), 0);
    return NextResponse.json({ notices, unread }, { headers: NO_STORE });
  } catch (err) {
    return answered(err);
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401, headers: NO_STORE });
    if (!allowNoticeMark(accountId)) {
      return NextResponse.json({ error: 'Too many requests. Try again in a while.' }, { status: 429, headers: NO_STORE });
    }
    const body = (await req.json().catch(() => null)) as { id?: unknown; all?: unknown } | null;
    const all = body?.all === true;
    const id = typeof body?.id === 'string' ? body.id : '';
    if (all === Boolean(id) || (id && !UUID.test(id))) {
      return NextResponse.json({ error: 'Choose one notice or all of them.' }, { status: 400, headers: NO_STORE });
    }
    await markPaymentNotices(getSupabase(), accountId, all ? { all: true } : { id });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return answered(err);
  }
}
