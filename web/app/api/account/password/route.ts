import { NextResponse } from 'next/server';
import { createSession, getAccountIdFromCookie, revokeAllSessions } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { validatePassword } from '../../../../lib/passwordPolicy';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody, logApiError } from '../../../../lib/apiError';
import {
  listLinkedChats,
  lockAllChats,
  mailOwner,
  passwordChangedMail,
} from '../../../../lib/securityNotice.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';

const ROUTE = 'POST /api/account/password';

/**
 * Change the account password.
 *
 * The current password goes through the same gate as every sensitive change,
 * so wrong guesses here climb the account's re-auth lockout ladder. The new
 * one must pass the signup rules.
 *
 * Every session is then revoked and this browser gets a fresh one: a password
 * is changed most often because it may have leaked, and a changed credential
 * must not leave old sessions alive (see revokeAllSessions).
 *
 * Every linked chat is locked too, so a chat someone attached with a stolen
 * password cannot keep spending once the owner changes it: each chat has to
 * unlock again with the PIN. The owner is emailed the list of linked chats so
 * they can spot one they do not recognise.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null;
    const current = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body?.newPassword === 'string' ? body.newPassword : '';

    // Before any hashing: no real password is this long, and checking one costs a key derivation.
    if (current.length > 256) return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    const rule = validatePassword(next);
    if (!rule.ok) return NextResponse.json({ error: rule.error }, { status: 400 });
    if (next === current) {
      return NextResponse.json({ error: 'Choose a new password, not the one you use now.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const auth = await requirePassword(supabase, accountId, current, 'change your password');
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const { error } = await supabase
      .from('accounts')
      .update({ password_hash: hashPassword(next) })
      .eq('id', accountId);
    if (error) return NextResponse.json(apiErrorBody(ROUTE, error, { accountId }), { status: 500 });

    // The password has changed by now. Each step reports what really happened
    // rather than claim other devices were signed out.
    let signedOutElsewhere = true;
    try {
      await revokeAllSessions(accountId);
    } catch (err) {
      signedOutElsewhere = false;
      logApiError(ROUTE, err, { accountId, step: 'revoke' });
    }
    let stillSignedIn = true;
    if (signedOutElsewhere) {
      try {
        await createSession(accountId);
      } catch (err) {
        // This browser lost its session with the rest; it will be asked to log in.
        stillSignedIn = false;
        logApiError(ROUTE, err, { accountId, step: 'session' });
      }
    }
    let chatsLocked = true;
    try {
      await lockAllChats(supabase, accountId);
    } catch (err) {
      chatsLocked = false;
      logApiError(ROUTE, err, { accountId, step: 'lock-chats' });
    }
    let chats: Awaited<ReturnType<typeof listLinkedChats>> = [];
    try {
      chats = await listLinkedChats(supabase, accountId);
    } catch (err) {
      logApiError(ROUTE, err, { accountId, step: 'list-chats' });
    }
    await mailOwner(supabase, accountId, passwordChangedMail(siteOrigin(), chats, new Date(), chatsLocked));
    return NextResponse.json({ ok: true, signedOutElsewhere, stillSignedIn, chatsLocked });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
