import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { verifyPassword } from '../../../../lib/cryptoPin';
import { createSession, hasTrustedLoginDevice } from '../../../../lib/cookies';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { apiErrorBody } from '../../../../lib/apiError';
import {
  consumeEmailVerificationCode,
  issueEmailVerificationCode,
} from '../../../../lib/emailVerify.ts';

const ROUTE = 'POST /api/auth/login';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    const code = String(body.code || '').replace(/\D/g, '');

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('accounts')
      .select('id, email, email_verified_at, password_hash, display_name')
      .eq('email', email)
      .maybeSingle();

    // An account lookup that fails must not describe the accounts table to
    // whoever is trying to log in.
    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }
    // Deliberately identical whether the email is unknown or the password is
    // wrong: this one stays as written.
    if (!data?.password_hash || !verifyPassword(password, data.password_hash)) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const remembered = hasTrustedLoginDevice(data.id);
    if (!remembered && !code) {
      const issued = await issueEmailVerificationCode({
        accountId: data.id,
        email: data.email,
        purpose: 'login',
      });
      if (!issued.ok) {
        return NextResponse.json(
          { error: issued.error, code: issued.code || 'LOGIN_CODE' },
          { status: issued.status }
        );
      }
      return NextResponse.json({
        needsCode: true,
        email: data.email,
        ...(issued.devCode ? { devCode: issued.devCode } : {}),
      });
    }

    if (!remembered && code) {
      const consumed = await consumeEmailVerificationCode({
        accountId: data.id,
        email: data.email,
        purpose: 'login',
        code,
      });
      if (!consumed.ok) {
        return NextResponse.json(
          { error: consumed.error, code: consumed.code || 'LOGIN_CODE' },
          { status: consumed.status }
        );
      }
    }

    await createSession(data.id);
    return NextResponse.json({
      account: toPublicAccount({
        email: data.email,
        email_verified_at: data.email_verified_at,
        display_name: data.display_name,
      }),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
