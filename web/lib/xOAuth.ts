/**
 * X (Twitter) OAuth 2.0 with PKCE. Plain fetch, no SDK.
 * Scope: users.read offline.access — enough for id + username.
 * Access token discarded after the user read.
 *
 * PKCE code_verifier is carried inside the signed OAuth state payload via a
 * short-lived cookie so the callback can complete the token exchange.
 */

import { createHash, randomBytes } from 'crypto';
import { cookies } from 'next/headers';

const AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const USER_URL = 'https://api.twitter.com/2/users/me';
const SCOPE = 'users.read offline.access';
const PKCE_COOKIE = 'flizy_x_pkce';

function clientId(): string {
  return process.env.X_OAUTH_CLIENT_ID || process.env.TWITTER_OAUTH_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.X_OAUTH_CLIENT_SECRET || process.env.TWITTER_OAUTH_CLIENT_SECRET || '';
}

export function redirectUri(): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  return `${base}/api/auth/x/callback`;
}

export function xOAuthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && redirectUri().startsWith('http'));
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint PKCE pair and store verifier in an httpOnly cookie for the callback. */
export function createPkceAndStore(): { challenge: string; method: 'S256' } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  cookies().set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return { challenge, method: 'S256' };
}

export function takePkceVerifier(): string | null {
  const jar = cookies();
  const v = jar.get(PKCE_COOKIE)?.value || null;
  jar.set(PKCE_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return v;
}

export function xAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type XIdentity = {
  externalId: string;
  login: string;
};

export async function exchangeCodeForIdentity(
  code: string,
  codeVerifier: string
): Promise<XIdentity | null> {
  try {
    const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code_verifier: codeVerifier,
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
      cache: 'no-store',
    });

    if (!tokenRes.ok) {
      console.error(`[oauth:x] token exchange failed: HTTP ${tokenRes.status}`);
      return null;
    }

    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody?.access_token) {
      console.error(`[oauth:x] no token: ${tokenBody?.error || 'unknown'}`);
      return null;
    }

    const userRes = await fetch(`${USER_URL}?user.fields=username,name`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      cache: 'no-store',
    });

    if (!userRes.ok) {
      console.error(`[oauth:x] user read failed: HTTP ${userRes.status}`);
      return null;
    }

    const payload = (await userRes.json()) as {
      data?: { id?: string; username?: string; name?: string };
    };
    const id = payload?.data?.id != null ? String(payload.data.id) : '';
    if (!/^\d+$/.test(id)) {
      console.error('[oauth:x] missing numeric id');
      return null;
    }
    const login = String(payload.data?.username || payload.data?.name || '').trim() || id;
    return { externalId: id, login };
  } catch (err) {
    console.error(`[oauth:x] exchange threw: ${(err as Error).message}`);
    return null;
  }
}
