/**
 * Finish Google sign-in.
 *
 * Order: rate limit, the cookie we set, the signed state, then the code
 * exchange. The email comes from Google's profile, never from the query.
 * A verified Flizy account on that email gets a session. Nothing else does.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { clientIpKey } from '../../../../../lib/clientIp.ts';
import { exchangeGoogleCode, googleAuthOrigin, googleOAuthConfigured } from '../../../../../lib/googleOAuth';
import { createSession, revokeAllSessions } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { isMissingClosureColumn } from '../../../../../lib/accountClosure.ts';
import { logApiError } from '../../../../../lib/apiError';
import {
  GOOGLE_LOGIN_COOKIE,
  allowGoogleAttempt,
  decideGoogleAccount,
  unpackGoogleTicket,
  type GoogleAccountRow,
  type GoogleTicket,
} from '../../../../../lib/googleLogin';

export const dynamic = 'force-dynamic';

const ROUTE = 'GET /api/auth/google/callback';

function cookieBase() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

function send(path: string, clear: boolean) {
  const res = NextResponse.redirect(new URL(path, googleAuthOrigin()));
  res.headers.set('cache-control', 'no-store');
  if (clear) res.cookies.set(GOOGLE_LOGIN_COOKIE, '', { ...cookieBase(), maxAge: 0 });
  return res;
}

function formAgain(ticket: GoogleTicket | null, code: string, clear: boolean) {
  const back = ticket?.back || '/login';
  const url = new URL(back, googleAuthOrigin());
  url.searchParams.set('google', code);
  if (ticket && ticket.next !== '/dashboard') url.searchParams.set('next', ticket.next);
  return send(`${url.pathname}${url.search}`, clear);
}

async function restoreAccount(accountId: string): Promise<boolean> {
  try {
    await revokeAllSessions(accountId);
  } catch (err) {
    logApiError(ROUTE, err);
    return false;
  }
  const { data, error } = await getSupabase()
    .from('accounts')
    .update({ deactivated_at: null, deleted_at: null })
    .eq('id', accountId)
    .select('id')
    .maybeSingle();
  if (error && isMissingClosureColumn(error)) return true;
  if (error) {
    logApiError(ROUTE, error);
    return false;
  }
  return Boolean(data?.id);
}

async function findAccount(
  email: string
): Promise<{ ok: true; row: GoogleAccountRow | null } | { ok: false }> {
  const supabase = getSupabase();
  const first = await supabase
    .from('accounts')
    .select('id, email_verified_at, deleted_at, deactivated_at')
    .eq('email', email)
    .maybeSingle();
  if (!first.error) return { ok: true, row: first.data };
  if (!isMissingClosureColumn(first.error)) {
    logApiError(ROUTE, first.error);
    return { ok: false };
  }
  const retry = await supabase
    .from('accounts')
    .select('id, email_verified_at')
    .eq('email', email)
    .maybeSingle();
  if (retry.error) {
    logApiError(ROUTE, retry.error);
    return { ok: false };
  }
  return { ok: true, row: retry.data ? { ...retry.data, deleted_at: null, deactivated_at: null } : null };
}

export async function GET(req: Request) {
  try {
    if (!allowGoogleAttempt(clientIpKey(req.headers))) return formAgain(null, 'limited', false);
    if (!googleOAuthConfigured() || !oauthStateConfigured()) {
      console.error('[oauth:google] Google OAuth env is incomplete');
      return formAgain(null, 'unavailable', true);
    }

    const url = new URL(req.url);
    const ticket = unpackGoogleTicket(cookies().get(GOOGLE_LOGIN_COOKIE)?.value);
    const state = url.searchParams.get('state') || '';
    // The state we mint is short. A huge query is refused before the HMAC.
    if (state.length > 2000) return formAgain(ticket, 'expired', false);
    const check = ticket ? verifyOAuthState(state, ticket.nonce) : { ok: false as const };
    if (!ticket || !check.ok) return formAgain(ticket, 'expired', false);

    const providerError = url.searchParams.get('error') || '';
    if (providerError === 'access_denied') return formAgain(ticket, 'cancelled', true);
    const code = url.searchParams.get('code') || '';
    const profile = await exchangeGoogleCode(code, ticket.verifier);
    if (!profile) return formAgain(ticket, 'failed', true);

    const found = await findAccount(profile.email);
    if (!found.ok) return formAgain(ticket, 'failed', true);
    const decision = decideGoogleAccount(found.row);
    if (decision.action === 'reject') return formAgain(ticket, decision.reason, true);
    if (decision.restore && !(await restoreAccount(decision.accountId))) {
      return formAgain(ticket, 'failed', true);
    }

    const res = send(ticket.next, true);
    await createSession(decision.accountId, res);
    return res;
  } catch (err) {
    logApiError(ROUTE, err);
    return formAgain(null, 'failed', true);
  }
}
