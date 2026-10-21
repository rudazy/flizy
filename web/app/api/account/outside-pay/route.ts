/**
 * Whether this account's pay links can be paid from wallets outside Flizy.
 * Off by default: turning it on hands the wallet address to anyone with the
 * link, which ties the @username and Flizy number to that wallet's on-chain
 * activity. Same shape as /api/account/scan-visibility, the other switch
 * about what the public can see.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';

const GET_ROUTE = 'GET /api/account/outside-pay';
const POST_ROUTE = 'POST /api/account/outside-pay';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { data, error } = await getSupabase()
      .from('accounts')
      .select('accept_outside_pay')
      .eq('id', accountId)
      .single();
    if (error) return NextResponse.json(apiErrorBody(GET_ROUTE, error), { status: 500 });
    return NextResponse.json({ enabled: data?.accept_outside_pay === true });
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
      .update({ accept_outside_pay: body.enabled })
      .eq('id', accountId)
      .select('accept_outside_pay')
      .single();
    if (error) return NextResponse.json(apiErrorBody(POST_ROUTE, error), { status: 500 });
    return NextResponse.json({ enabled: data?.accept_outside_pay === true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(POST_ROUTE, err), { status: 500 });
  }
}
