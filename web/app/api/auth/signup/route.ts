import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { createSession } from '../../../../lib/cookies';
import { validatePassword } from '../../../../lib/passwordPolicy';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { normalizeLocale } from '../../../../lib/locale';
import { apiErrorBody } from '../../../../lib/apiError';
import { attributeSignup, resolveSignupInvite } from '../../../../lib/invite.ts';
import { readInviteCookie, readInviteSource } from '../../../../lib/inviteCookie.ts';
import { parseEmail } from '../../../../lib/email';
import { isHoneypotFilled } from '../../../../lib/honeypot.ts';
import { checkSignupRateLimit, signupIpKey } from '../../../../lib/signupLimit.ts';

const ROUTE = 'POST /api/auth/signup';

/**
 * Stage 1 of onboarding: email + password only.
 * Stage 2 (verify email) and stage 3 (username + display name) run on /dashboard.
 *
 * The three guards at the top run in cost order: the honeypot and the address
 * check are free, the cap costs a round trip, so nothing malformed ever reaches
 * the database. The cap sits last of the three and immediately before the
 * insert, because it charges the caller and a request that was going to be
 * refused anyway should not spend anyone's budget.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Not a person. Answer exactly as a taken address does, so the response
    // cannot be used to find out which field is the trap.
    if (isHoneypotFilled(body)) {
      return NextResponse.json({ error: 'Could not create that account.' }, { status: 400 });
    }

    const email = parseEmail(body.email);
    const password = String(body.password || '');
    const locale = normalizeLocale(body.locale);

    // The form sends type="email" required, which is the browser's opinion and
    // not a check. parseEmail is the one that counts: it bounds the length and
    // rejects a shape that would otherwise be handed straight to the mailer.
    if (!email) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    const pw = validatePassword(password);
    if (!pw.ok) {
      return NextResponse.json({ error: pw.error }, { status: 400 });
    }

    const supabase = getSupabase();

    const rate = await checkSignupRateLimit(supabase, signupIpKey(req.headers));
    if (!rate.ok) {
      return NextResponse.json({ error: rate.error, code: rate.code }, { status: rate.status });
    }

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
        return NextResponse.json({ error: 'Could not create that account.' }, { status: 400 });
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    const { data: withWallet, error: wErr } = await supabase
      .from('accounts')
      .update({ agent_wallet_address: predictGatorAddress(data.id) })
      .eq('id', data.id)
      .select(
        'email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth'
      )
      .single();
    if (wErr) {
      return NextResponse.json(apiErrorBody(ROUTE, wErr, { accountId: data.id }), { status: 500 });
    }

    await createSession(data.id);

    try {
      const typed = body.inviteCode ?? body.invite ?? '';
      const resolved = resolveSignupInvite(typed, readInviteCookie(), readInviteSource());
      // Inviter id from the body is ignored. Only a public code is accepted.
      await attributeSignup(supabase, {
        inviteeAccountId: data.id,
        code: resolved.code,
        source: resolved.source,
      });
    } catch (err) {
      console.warn('[signup] attribution:', err instanceof Error ? err.message : err);
    }

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
