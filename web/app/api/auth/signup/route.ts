import { NextResponse } from 'next/server';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { validatePassword } from '../../../../lib/passwordPolicy';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';
import { normalizeLocale } from '../../../../lib/locale';
import { apiErrorBody } from '../../../../lib/apiError';
import { attributeSignup, resolveSignupInvite } from '../../../../lib/invite.ts';
import { readInviteCookie, readInviteSource } from '../../../../lib/inviteCookie.ts';
import { parseEmail } from '../../../../lib/email';
import { isHoneypotFilled } from '../../../../lib/honeypot.ts';
import { checkSignupRateLimit } from '../../../../lib/signupLimit.ts';
import { clientIpKey } from '../../../../lib/clientIp.ts';
import { countryByIso } from '../../../../lib/phoneFormat';
import { issueEmailVerificationCode } from '../../../../lib/emailVerify.ts';
import { mailOwner, signupAttemptMail } from '../../../../lib/securityNotice.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';
import { onceWithin, signupNoticeKey } from '../../../../lib/loginAttempts.ts';

/** The owner hears of signup attempts with their address at most this often. */
const SIGNUP_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ROUTE = 'POST /api/auth/signup';

const ACCOUNT_RETURNING =
  'id, email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address';

function missingAccountColumn(
  error: { code?: string; message?: string } | null,
  column: string
) {
  if (!error) return false;
  const message = String(error.message || '');
  return (
    (error.code === '42703' || error.code === 'PGRST204' || /column|schema cache/i.test(message)) &&
    new RegExp(column, 'i').test(message)
  );
}

/**
 * Country columns ship in a hand-applied migration. Signup still creates the
 * account when those columns are not there yet. The country is simply unset.
 */
async function insertAccount(
  supabase: ReturnType<typeof getSupabase>,
  row: Record<string, unknown>
) {
  const payload = { ...row };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await supabase.from('accounts').insert(payload).select(ACCOUNT_RETURNING).single();
    if (!result.error) return result;
    if (missingAccountColumn(result.error, 'default_country_iso') && 'default_country_iso' in payload) {
      delete payload.default_country_iso;
      continue;
    }
    if (missingAccountColumn(result.error, 'default_calling_code') && 'default_calling_code' in payload) {
      delete payload.default_calling_code;
      continue;
    }
    return result;
  }
  return supabase.from('accounts').insert(payload).select(ACCOUNT_RETURNING).single();
}

/**
 * The one answer signup gives once the input is well formed. It is the same
 * whether the email was new, already had an unverified account, or belongs to
 * a verified account, so signup cannot be used to find out which addresses
 * have a Flizy account.
 */
function codeSent(email: string, devCode?: string) {
  return NextResponse.json({ needsCode: true, email, ...(devCode ? { devCode } : {}) });
}

/**
 * Send the signup code. Failures are logged, never shown: see codeSent.
 *
 * pendingPasswordHash waits on the code and becomes the password only when
 * that code is entered (POST /api/auth/signup/verify).
 */
async function sendSignupCode(
  accountId: string,
  email: string,
  pendingPasswordHash?: string
): Promise<string | undefined> {
  const issued = await issueEmailVerificationCode({ accountId, email, purpose: 'primary', pendingPasswordHash });
  if (!issued.ok) {
    console.warn(`[signup] code not sent: ${issued.code || issued.status}`);
    return undefined;
  }
  return issued.devCode;
}

/**
 * Stage 1 of onboarding: email and password, then a code from the inbox.
 *
 * No session is created here. POST /api/auth/signup/verify creates it once
 * the code proves the inbox, which is what makes the answer below safe to give
 * for an address that already has an account:
 *
 *   - new address: the account is created unverified and a code is sent.
 *   - an account that never verified its email: a fresh code is sent, and the
 *     password typed now waits on that code. The account's password does not
 *     change here; it changes only when the code is entered, so nobody can
 *     lock an unverified owner out by signing up with their address. Whoever
 *     proves the inbox ends up with the account and the password they chose,
 *     which is also the only way back for someone who mistyped it the first
 *     time.
 *   - a verified account: nothing changes, and the owner is emailed that
 *     someone tried to sign up with their address, at most once a day.
 *
 * The guards run in cost order: the honeypot and the address check are free,
 * the cap costs a round trip, so nothing malformed ever reaches the database.
 * The cap charges every well-formed attempt, on every branch.
 */
export async function POST(req: Request) {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  try {
    const body = await req.json();

    // Not a person. Answered like every accepted signup, so the response
    // cannot be used to find out which field is the trap.
    if (isHoneypotFilled(body)) {
      return codeSent(parseEmail(body.email) || '');
    }

    const email = parseEmail(body.email);
    const password = String(body.password || '');
    const locale = normalizeLocale(body.locale);
    const chosen = countryByIso(String(body.countryIso || ''));
    if (String(body.countryIso || '').trim() && !chosen) {
      return NextResponse.json({ error: 'Pick a country from the list, or leave it empty.' }, { status: 400 });
    }

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

    const rate = await checkSignupRateLimit(supabase, clientIpKey(req.headers));
    if (!rate.ok) {
      return NextResponse.json({ error: rate.error, code: rate.code }, { status: rate.status });
    }

    // Every branch pays for one hash, so the time taken does not say which
    // branch ran.
    const password_hash = hashPassword(password);

    const { data: existing, error: readError } = await supabase
      .from('accounts')
      .select('id, email_verified_at')
      .eq('email', email)
      .maybeSingle();
    if (readError) {
      return NextResponse.json(apiErrorBody(ROUTE, readError), { status: 500 });
    }

    if (existing?.email_verified_at) {
      // Once a day at most: anyone can trigger this, from any number of
      // addresses, and it must not become a way to flood the owner's inbox.
      if (await onceWithin(supabase, signupNoticeKey(existing.id), SIGNUP_NOTICE_WINDOW_MS)) {
        await mailOwner(supabase, existing.id, signupAttemptMail(siteOrigin(), new Date()));
      }
      return codeSent(email);
    }

    if (existing) {
      return codeSent(email, await sendSignupCode(existing.id, email, password_hash));
    }

    const inserted = await insertAccount(supabase, {
      email,
      password_hash,
      display_name: null,
      username: null,
      username_changed_at: null,
      locale,
      agent_wallet_address: null,
      email_verified_at: null,
      ...(chosen
        ? { default_calling_code: chosen.dial, default_country_iso: chosen.iso }
        : {}),
    });
    const { data, error } = inserted;

    if (error) {
      // Another signup for this address landed first. Same answer as any
      // existing address, and that request already sent its own code.
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        return codeSent(email);
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    const { error: wErr } = await supabase
      .from('accounts')
      .update({ agent_wallet_address: predictGatorAddress(data.id) })
      .eq('id', data.id);
    if (wErr) {
      return NextResponse.json(apiErrorBody(ROUTE, wErr, { accountId: data.id }), { status: 500 });
    }

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

    return codeSent(email, await sendSignupCode(data.id, email));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
