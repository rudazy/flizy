/**
 * Stage 2 of signup: the code from the inbox, then the session.
 *
 * POST /api/auth/signup sends the code and signs nobody in. This is where an
 * account becomes usable: the code proves the inbox, the email is marked
 * verified, and every older session on the account is signed out before this
 * browser gets a new one.
 *
 * At a re-signup (an account that never verified its email), the password
 * chosen at that signup becomes the password only here; until now the
 * earlier one kept working. The account is then handed over clean
 * (web/lib/accountReset.ts): PIN cleared, every chat and platform unlinked,
 * the trusted list emptied, and the address that verified is emailed why. Signing the other sessions
 * out matters for the same reason: whoever proves the inbox now is the owner,
 * and no session from before that proof is theirs to trust.
 *
 * Every failure gives the same answer, whether the address is unknown,
 * already verified, or the code is wrong, so this cannot be used to find out
 * which addresses have an account either. The per-code attempt limit in
 * emailVerify.ts still applies, and a burnt code needs a new signup request.
 */

import { NextResponse } from 'next/server';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { getSupabase } from '../../../../../lib/supabase';
import { createSession, revokeAllSessions } from '../../../../../lib/cookies';
import { parseEmail } from '../../../../../lib/email';
import { consumeEmailVerificationCode } from '../../../../../lib/emailVerify.ts';
import { toPublicAccount } from '../../../../../lib/publicAccount';
import { apiErrorBody, logApiError } from '../../../../../lib/apiError';
import { resetForNewOwner, type ResetResult } from '../../../../../lib/accountReset.ts';
import { accountResetMail, mailOwner } from '../../../../../lib/securityNotice.ts';
import { siteOrigin } from '../../../../../lib/siteOrigin';

const ROUTE = 'POST /api/auth/signup/verify';

const WRONG = 'That code is wrong or has expired. Check the latest email, or sign up again for a new code.';

export async function POST(req: Request) {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    const email = parseEmail(body.email);
    const code = String(body.code || '').replace(/\D/g, '');
    if (!email || code.length !== 6) {
      return NextResponse.json({ error: WRONG }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: account, error } = await supabase
      .from('accounts')
      .select('id, email_verified_at')
      .eq('email', email)
      .maybeSingle();
    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }
    if (!account || account.email_verified_at) {
      return NextResponse.json({ error: WRONG }, { status: 400 });
    }

    const consumed = await consumeEmailVerificationCode({
      accountId: account.id,
      email,
      purpose: 'primary',
      code,
    });
    if (!consumed.ok) {
      // Too many wrong codes is worth saying: the next step is a new code.
      const tooMany = consumed.status === 429;
      return NextResponse.json(
        { error: tooMany ? consumed.error : WRONG },
        { status: tooMany ? 429 : 400 }
      );
    }

    // A re-signup's password waited on this code (see the signup route). It
    // becomes the password only now that the inbox is proven, and the account
    // is handed over clean: whoever set it up before may not own this inbox.
    let reset: ResetResult | null = null;
    if (consumed.pendingPasswordHash) {
      try {
        reset = await resetForNewOwner(supabase, account.id, consumed.pendingPasswordHash);
      } catch (err) {
        // The code already marked the email verified. Undo that, or the next
        // attempt would take the verified-owner path and the account would
        // keep the earlier holder's PIN and links. The reset is safe to run
        // again, so a fresh signup finishes it.
        logApiError(ROUTE, err, { accountId: account.id });
        await supabase.from('accounts').update({ email_verified_at: null }).eq('id', account.id);
        return NextResponse.json({ error: 'Could not finish. Sign up again for a new code.' }, { status: 500 });
      }
    }

    await revokeAllSessions(account.id);
    await createSession(account.id);

    if (reset) {
      await mailOwner(supabase, account.id, accountResetMail(siteOrigin(), reset.unlinked, reset.trustedRemoved, new Date()));
    }

    const { data: fresh } = await supabase
      .from('accounts')
      .select('email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth')
      .eq('id', account.id)
      .maybeSingle();
    return NextResponse.json({ account: fresh ? toPublicAccount(fresh) : null });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
