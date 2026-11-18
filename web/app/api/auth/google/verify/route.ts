/**
 * The second step of a Google sign-in on a browser Flizy does not remember:
 * the emailed login code. The account comes from the signed note the callback
 * left (GOOGLE_PENDING_COOKIE), never from the body, which carries only the
 * code, or { resend: true } for a new one. A right code opens the session and
 * remembers the browser, the same as a password sign-in.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { clientIpKey } from '../../../../../lib/clientIp.ts';
import { createSession } from '../../../../../lib/cookies';
import { restoreAccount } from '../../../../../lib/accountRestore';
import { apiErrorBody } from '../../../../../lib/apiError';
import { consumeEmailVerificationCode, issueEmailVerificationCode } from '../../../../../lib/emailVerify.ts';
import { GOOGLE_PENDING_COOKIE, allowGoogleAttempt, unpackGooglePending } from '../../../../../lib/googleLogin';

export const dynamic = 'force-dynamic';

const ROUTE = 'POST /api/auth/google/verify';
const NO_STORE = { 'cache-control': 'no-store' };
const EXPIRED = { error: 'That Google sign-in expired. Continue with Google again.', code: 'GOOGLE_EXPIRED' };

function clearNote(res: NextResponse) {
  res.cookies.set(GOOGLE_PENDING_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}

export async function POST(req: Request) {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  try {
    if (!allowGoogleAttempt(clientIpKey(req.headers))) {
      return NextResponse.json({ error: 'Too many Google sign-in attempts. Try again in a while.' }, { status: 429, headers: NO_STORE });
    }
    const pending = unpackGooglePending((await cookies()).get(GOOGLE_PENDING_COOKIE)?.value, process.env.OAUTH_STATE_SECRET || '');
    if (!pending) return clearNote(NextResponse.json(EXPIRED, { status: 400, headers: NO_STORE }));

    const body = await req.json().catch(() => ({}));
    if (body?.resend === true) {
      const issued = await issueEmailVerificationCode({ accountId: pending.accountId, email: pending.email, purpose: 'login' });
      if (!issued.ok) {
        return NextResponse.json({ error: issued.error, code: issued.code || 'LOGIN_CODE' }, { status: issued.status, headers: NO_STORE });
      }
      return NextResponse.json({ ok: true, resent: true, ...(issued.devCode ? { devCode: issued.devCode } : {}) }, { headers: NO_STORE });
    }

    const code = String(body?.code || '').replace(/\D/g, '');
    const consumed = await consumeEmailVerificationCode({ accountId: pending.accountId, email: pending.email, purpose: 'login', code });
    if (!consumed.ok) {
      return NextResponse.json({ error: consumed.error, code: consumed.code || 'LOGIN_CODE' }, { status: consumed.status, headers: NO_STORE });
    }
    if (pending.restore && !(await restoreAccount(pending.accountId, ROUTE))) {
      return NextResponse.json({ error: 'Could not sign you in. Try again.' }, { status: 500, headers: NO_STORE });
    }

    const res = NextResponse.json({ ok: true, next: pending.next }, { headers: NO_STORE });
    await createSession(pending.accountId, res);
    return clearNote(res);
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500, headers: NO_STORE });
  }
}
