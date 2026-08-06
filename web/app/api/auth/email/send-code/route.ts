import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { parseEmail } from '../../../../../lib/email';
import {
  issueEmailVerificationCode,
  normalizePurpose,
} from '../../../../../lib/emailVerify';
import { apiErrorBody } from '../../../../../lib/apiError';

const ROUTE = 'POST /api/auth/email/send-code';

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const purpose = normalizePurpose(body.purpose) || 'primary';
    const supabase = getSupabase();

    let email = parseEmail(body.email);
    if (purpose === 'primary') {
      const { data: acc, error } = await supabase
        .from('accounts')
        .select('email, email_verified_at')
        .eq('id', accountId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      email = parseEmail(acc?.email);
      if (!email) {
        return NextResponse.json({ error: 'No registration email on this account.' }, { status: 400 });
      }
      if (acc?.email_verified_at) {
        return NextResponse.json({ error: 'Registration email is already verified.' }, { status: 400 });
      }
    } else {
      if (!email) {
        return NextResponse.json({ error: 'Email is required for secondary verification.' }, { status: 400 });
      }
      const { data: row, error } = await supabase
        .from('account_emails')
        .select('id, verified_at')
        .eq('account_id', accountId)
        .ilike('email', email)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) {
        return NextResponse.json(
          { error: 'Add that email on Account first, then request a code.' },
          { status: 400 }
        );
      }
      if (row.verified_at) {
        return NextResponse.json({ error: 'That email is already verified.' }, { status: 400 });
      }
    }

    const result = await issueEmailVerificationCode({
      accountId,
      email: email!,
      purpose,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }

    return NextResponse.json({
      ok: true,
      email: result.email,
      expiresAt: result.expiresAt,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
