import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { requirePassword } from '../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../lib/apiError';

const ROUTE = 'POST /api/limits';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const raw = body.daily_send_limit_eth;

    let daily: number | null;
    if (raw === null || raw === '' || raw === undefined) {
      daily = null;
    } else {
      daily = Number(raw);
      if (!Number.isFinite(daily) || daily < 0) {
        return NextResponse.json(
          { error: 'Limit must be a number >= 0, or empty to clear (app default)' },
          { status: 400 }
        );
      }
      if (daily > 1000) {
        return NextResponse.json({ error: 'Limit too large' }, { status: 400 });
      }
    }

    const supabase = getSupabase();
    const auth = await requirePassword(
      supabase,
      accountId,
      String(body.password || ''),
      'change your send limit'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const { error } = await supabase
      .from('accounts')
      .update({ daily_send_limit_eth: daily })
      .eq('id', accountId);
    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error, { accountId }), { status: 500 });
    }

    return NextResponse.json({ ok: true, daily_send_limit_eth: daily });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
