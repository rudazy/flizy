import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword, verifyPassword } from '../../../../lib/cryptoPin';
import { createSession, hasTrustedLoginDevice, revokeAllSessions } from '../../../../lib/cookies';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { apiErrorBody } from '../../../../lib/apiError';
import {
  consumeEmailVerificationCode,
  issueEmailVerificationCode,
} from '../../../../lib/emailVerify.ts';
import {
  clearFailedLogins,
  loginLockState,
  loginLockedMessage,
  LOGIN_LOCKED,
  recordFailedLogin,
} from '../../../../lib/loginAttempts.ts';
import { closureOf, isMissingClosureColumn } from '../../../../lib/accountClosure.ts';

const ROUTE = 'POST /api/auth/login';

/** Same cost as a real check so an unknown email is not the fast 401. */
let dummyHash: string | null = null;
function dummyPasswordHash(): string {
  if (!dummyHash) dummyHash = hashPassword('flizy-login-timing-dummy');
  return dummyHash;
}

function lockedResponse(retryAfterText: string) {
  return NextResponse.json(
    { error: loginLockedMessage(retryAfterText), code: LOGIN_LOCKED },
    { status: 429 }
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    const code = String(body.code || '').replace(/\D/g, '');

    const supabase = getSupabase();

    if (email) {
      const lock = await loginLockState(supabase, email);
      if (lock.locked && lock.retryAfterText) {
        return lockedResponse(lock.retryAfterText);
      }
    }

    let { data, error } = await supabase
      .from('accounts')
      .select('id, email, email_verified_at, password_hash, display_name, deleted_at, deactivated_at')
      .eq('email', email)
      .maybeSingle();

    if (error && isMissingClosureColumn(error)) {
      const retry = await supabase
        .from('accounts')
        .select('id, email, email_verified_at, password_hash, display_name')
        .eq('email', email)
        .maybeSingle();
      data = retry.data ? { ...retry.data, deleted_at: null, deactivated_at: null } : null;
      error = retry.error;
    }

    // An account lookup that fails must not describe the accounts table to
    // whoever is trying to log in.
    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }
    // Deliberately identical whether the email is unknown or the password is
    // wrong: this one stays as written. Unknown addresses still pay scrypt so
    // the 401 is not the cheap path, then they climb the same lockout ladder.
    const stored = data?.password_hash || dummyPasswordHash();
    const matches = verifyPassword(password, stored);
    if (!data?.password_hash || !matches) {
      if (email) {
        const recorded = await recordFailedLogin(supabase, email);
        if (recorded.retryAfterText) {
          return lockedResponse(recorded.retryAfterText);
        }
      }
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Said only after the password matches, so a wrong password still looks
    // like any other wrong password.
    if (closureOf(data) === 'deleted') {
      return NextResponse.json(
        { error: 'This account was deleted and cannot be restored.', code: 'ACCOUNT_DELETED' },
        { status: 403 }
      );
    }

    /*
     * An unrecognised browser needs the emailed code on every runtime. A local
     * build has no mail transport, so issueEmailVerificationCode returns the
     * code as `devCode` there and LoginForm shows it; the step itself is never
     * skipped, so development exercises the same path production does.
     */
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

    if (closureOf(data) === 'deactivated') {
      // Drop every old session before the pause flag clears. A revoke that
      // failed at deactivate would otherwise start working again the moment
      // this update lands, and this request has not created its own row yet.
      try {
        await revokeAllSessions(data.id);
      } catch (err) {
        return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
      }
      const { data: restored, error: restoreError } = await supabase
        .from('accounts')
        .update({ deactivated_at: null })
        .eq('id', data.id)
        .is('deleted_at', null)
        .select('id')
        .maybeSingle();
      if (restoreError) {
        return NextResponse.json(apiErrorBody(ROUTE, restoreError), { status: 500 });
      }
      if (!restored) {
        return NextResponse.json(
          { error: 'This account was deleted and cannot be restored.', code: 'ACCOUNT_DELETED' },
          { status: 403 }
        );
      }
    }

    await createSession(data.id);
    await clearFailedLogins(supabase, data.email);
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
