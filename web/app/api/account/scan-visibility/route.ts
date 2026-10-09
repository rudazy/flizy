/**
 * Whether Scan, the public ledger, may show this account's @username.
 * Off by default. Off, Scan shows the short wallet address or nothing.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';

const GET_ROUTE = 'GET /api/account/scan-visibility';
const POST_ROUTE = 'POST /api/account/scan-visibility';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { data, error } = await getSupabase()
      .from('accounts')
      .select('scan_show_username')
      .eq('id', accountId)
      .single();
    if (error) return NextResponse.json(apiErrorBody(GET_ROUTE, error), { status: 500 });
    return NextResponse.json({ showUsername: data?.scan_show_username === true });
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
    const body = (await req.json().catch(() => null)) as { showUsername?: unknown } | null;
    if (typeof body?.showUsername !== 'boolean') {
      return NextResponse.json({ error: 'Choose on or off.' }, { status: 400 });
    }
    const { data, error } = await getSupabase()
      .from('accounts')
      .update({ scan_show_username: body.showUsername })
      .eq('id', accountId)
      .select('scan_show_username')
      .single();
    if (error) return NextResponse.json(apiErrorBody(POST_ROUTE, error), { status: 500 });
    return NextResponse.json({ showUsername: data?.scan_show_username === true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(POST_ROUTE, err), { status: 500 });
  }
}
