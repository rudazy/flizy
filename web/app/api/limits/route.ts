import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { verifyPassword } from '../../../lib/cryptoPin';

export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const password = String(body.password || '');
    const raw = body.daily_send_limit_eth;

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

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
    const { data: account, error: aErr } = await supabase
      .from('accounts')
      .select('id, password_hash')
      .eq('id', accountId)
      .single();
    if (aErr || !account?.password_hash) {
      return NextResponse.json({ error: 'Could not verify account' }, { status: 400 });
    }
    if (!verifyPassword(password, account.password_hash)) {
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }

    const { error } = await supabase
      .from('accounts')
      .update({ daily_send_limit_eth: daily })
      .eq('id', accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, daily_send_limit_eth: daily });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Limit update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
