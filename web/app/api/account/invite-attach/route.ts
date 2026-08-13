import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/account/invite-attach';

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('accounts')
      .update({ attach_invite_on_claims: enabled })
      .eq('id', accountId)
      .select('attach_invite_on_claims')
      .single();

    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    return NextResponse.json({
      attachOnClaims: Boolean(data?.attach_invite_on_claims),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
