import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { parseEmail } from '../../../../../lib/email';
import {
  consumeEmailVerificationCode,
  normalizePurpose,
} from '../../../../../lib/emailVerify';
import { toPublicAccount } from '../../../../../lib/publicAccount';
import { apiErrorBody } from '../../../../../lib/apiError';

const ROUTE = 'POST /api/auth/email/verify';

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const purpose = normalizePurpose(body.purpose) || 'primary';
    const code = String(body.code || '');
    const supabase = getSupabase();

    let email = parseEmail(body.email);
    if (purpose === 'primary') {
      const { data: acc, error } = await supabase
        .from('accounts')
        .select('email')
        .eq('id', accountId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      email = parseEmail(acc?.email);
    }
    if (!email) {
      return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
    }

    const result = await consumeEmailVerificationCode({
      accountId,
      email,
      purpose,
      code,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }

    const { data: acc } = await supabase
      .from('accounts')
      .select(
        'email, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth, email_verified_at'
      )
      .eq('id', accountId)
      .maybeSingle();

    return NextResponse.json({
      ok: true,
      account: acc ? toPublicAccount(acc) : null,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
