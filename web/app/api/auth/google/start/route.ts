/**
 * Send the browser to Google.
 *
 * No session yet. A short-lived cookie holds the PKCE verifier and the nonce
 * the state is signed with. The account is chosen in the callback, after
 * Google has proved the email.
 */

import { NextResponse } from 'next/server';
import { createOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { safeNext } from '../../../../../lib/safeNext.ts';
import { clientIpKey } from '../../../../../lib/clientIp.ts';
import { googleAuthOrigin, googleAuthorizeUrl, googleOAuthConfigured, mintGooglePkce } from '../../../../../lib/googleOAuth';
import {
  GOOGLE_LOGIN_COOKIE,
  allowGoogleAttempt,
  googleBack,
  newGoogleNonce,
  packGoogleTicket,
} from '../../../../../lib/googleLogin';

export const dynamic = 'force-dynamic';

function cookieBase() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

function backTo(back: '/login' | '/signup', code: string, next: string) {
  const url = new URL(back, googleAuthOrigin());
  url.searchParams.set('google', code);
  if (next !== '/dashboard') url.searchParams.set('next', next);
  const res = NextResponse.redirect(url);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = googleBack(url.searchParams.get('back'));
  const next = safeNext(url.searchParams.get('next'));
  if (!allowGoogleAttempt(clientIpKey(req.headers))) {
    return backTo(back, 'limited', next);
  }
  if (!googleOAuthConfigured() || !oauthStateConfigured()) {
    console.error('[oauth:google] Google OAuth env is incomplete');
    return backTo(back, 'unavailable', next);
  }

  const nonce = newGoogleNonce();
  const { verifier, challenge } = mintGooglePkce();
  const state = createOAuthState(nonce);
  const res = NextResponse.redirect(googleAuthorizeUrl(state, challenge));
  res.headers.set('cache-control', 'no-store');
  res.cookies.set(
    GOOGLE_LOGIN_COOKIE,
    packGoogleTicket({ nonce, verifier, next, back }),
    { ...cookieBase(), maxAge: 600 }
  );
  return res;
}
