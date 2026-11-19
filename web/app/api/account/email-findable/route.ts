/**
 * Whether people who know one of this account's verified emails can find it.
 * Off by default. On, a chat send to that email shows the sender the @username
 * and offers paying the wallet directly beside holding a claim. Off, a send to
 * it is held as a claim and reads exactly like a send to an address that is not
 * on Flizy. Same shape as /api/account/outside-pay.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';

const GET_ROUTE = 'GET /api/account/email-findable';
const POST_ROUTE = 'POST /api/account/email-findable';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { data, error } = await getSupabase()
      .from('accounts')
      .select('findable_by_email')
      .eq('id', accountId)
      .single();
    if (error) return NextResponse.json(apiErrorBody(GET_ROUTE, error), { status: 500 });
    return NextResponse.json({ enabled: data?.findable_by_email === true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Choose on or off.' }, { status: 400 });
    }
    const { data, error } = await getSupabase()
      .from('accounts')
      .update({ findable_by_email: body.enabled })
      .eq('id', accountId)
      .select('findable_by_email')
      .single();
    if (error) return NextResponse.json(apiErrorBody(POST_ROUTE, error), { status: 500 });
    return NextResponse.json({ enabled: data?.findable_by_email === true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(POST_ROUTE, err), { status: 500 });
  }
}
