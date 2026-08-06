import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { createSession } from '../../../../lib/cookies';
import { validatePassword } from '../../../../lib/passwordPolicy';
import { deriveAgentAddress } from '../../../../lib/agentWallet';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { normalizeLocale } from '../../../../lib/locale';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/auth/signup';

/**
 * Stage 1 of onboarding: email + password only.
 * Stage 2 (verify email) and stage 3 (username + display name) run on /dashboard.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    const locale = normalizeLocale(body.locale);

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }
    const pw = validatePassword(password);
    if (!pw.ok) {
      return NextResponse.json({ error: pw.error }, { status: 400 });
    }

    const supabase = getSupabase();
    const password_hash = hashPassword(password);
    const { data, error } = await supabase
      .from('accounts')
      .insert({
        email,
        password_hash,
        display_name: null,
        username: null,
        username_changed_at: null,
        locale,
        agent_wallet_address: null,
        email_verified_at: null,
      })
      .select(
        'id, email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address'
      )
      .single();

    if (error) {
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    const { data: withWallet, error: wErr } = await supabase
      .from('accounts')
      .update({ agent_wallet_address: deriveAgentAddress(data.id) })
      .eq('id', data.id)
      .select(
        'email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth'
      )
      .single();
    if (wErr) {
      return NextResponse.json(apiErrorBody(ROUTE, wErr, { accountId: data.id }), { status: 500 });
    }

    await createSession(data.id);

    let emailCodeSent = false;
    let emailCodeError: string | null = null;
    try {
      const { issueEmailVerificationCode } = await import('../../../../lib/emailVerify');
      const issued = await issueEmailVerificationCode({
        accountId: data.id,
        email,
        purpose: 'primary',
      });
      if (issued.ok) emailCodeSent = true;
      else emailCodeError = issued.error;
    } catch {
      emailCodeError = 'Could not send verification email.';
    }

    return NextResponse.json({
      account: toPublicAccount(withWallet),
      needsEmailVerification: true,
      needsProfile: true,
      emailCodeSent,
      emailCodeError,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
