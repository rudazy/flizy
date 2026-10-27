/**
 * Google sign-in, by hand.
 *
 * Plain fetch, no SDK. The client secret stays in this module. Nothing here
 * may be imported from a client component.
 *
 * The browser is sent to Google with a PKCE challenge. The callback exchanges
 * the code with the verifier and the client secret, reads the OpenID profile,
 * and drops the access token. No token is stored.
 */

import { createHash, randomBytes } from 'crypto';
import { parseEmail } from './email.ts';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const SUB = /^[0-9]{5,255}$/;

function clientId(): string {
  return process.env.GOOGLE_OAUTH_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
}

/**
 * Origin of this process, never the request Host header.
 *
 * SITE_URL wins. A local server can keep NEXT_PUBLIC_SITE_URL on the public
 * site for links, while this cookie is host-only and the callback has to come
 * back to the process that set it.
 */
export function googleAuthOrigin(): string {
  const raw = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://flizy.app';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://flizy.app';
  }
}

export function googleRedirectUri(): string {
  return `${googleAuthOrigin()}/api/auth/google/callback`;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && googleRedirectUri().startsWith('http'));
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintGooglePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function googleAuthorizeUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type GoogleProfile = {
  /** Immutable Google account id. Not stored. */
  sub: string;
  email: string;
};

/**
 * The fields we will accept from Google's userinfo document.
 * email_verified must be boolean true. A missing or false flag is a refusal.
 */
export function readGoogleProfile(body: unknown): GoogleProfile | null {
  if (!body || typeof body !== 'object') return null;
  const row = body as { sub?: unknown; email?: unknown; email_verified?: unknown };
  const sub = String(row.sub || '');
  const email = parseEmail(row.email);
  if (!SUB.test(sub) || !email) return null;
  if (row.email_verified !== true) return null;
  return { sub, email };
}

/**
 * Exchange the code and read the profile. Null on any provider failure.
 * The access token does not leave this function.
 */
export async function exchangeGoogleCode(
  code: string,
  verifier: string,
  doFetch: typeof fetch = fetch
): Promise<GoogleProfile | null> {
  if (!code || code.length > 512 || !verifier) return null;
  try {
    const tokenRes = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenRes.ok) {
      console.error(`[oauth:google] token exchange HTTP ${tokenRes.status}`);
      return null;
    }
    const tokenBody = (await tokenRes.json()) as { access_token?: string };
    const access = String(tokenBody?.access_token || '');
    if (!access) {
      console.error('[oauth:google] token exchange returned no access token');
      return null;
    }

    const userRes = await doFetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) {
      console.error(`[oauth:google] profile HTTP ${userRes.status}`);
      return null;
    }
    return readGoogleProfile(await userRes.json());
  } catch {
    console.error('[oauth:google] exchange failed');
    return null;
  }
}
