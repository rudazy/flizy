/**
 * Save or clear the signed-in account's dashboard background.
 * No password. This does not move money or change who can sign in.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { setAppearanceChoice } from '../../../../lib/accountBackground';

const ROUTE = 'POST /api/account/background';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    const body = (await req.json().catch(() => null)) as {
      mode?: unknown;
      preset?: unknown;
      dim?: unknown;
    } | null;
    const result = await setAppearanceChoice(deps(), accountId, body || {});
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    const result = await setAppearanceChoice(deps(), accountId, { mode: 'default' });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json(apiErrorBody('DELETE /api/account/background', err), { status: 500 });
  }
}

function deps() {
  return { supabase: getSupabase() };
}
