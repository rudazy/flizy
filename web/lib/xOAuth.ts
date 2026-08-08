/**
 * X (Twitter) OAuth 2.0 with PKCE. Plain fetch, no SDK.
 *
 * Scopes include tweet.read — X often refuses /2/users/me with users.read alone.
 * Access token is discarded after the identity read. Never stored.
 *
 * PKCE verifier is set on the authorize redirect response (httpOnly cookie).
 * Putting the verifier in the OAuth state query would defeat PKCE (callback URL
 * would carry both code and verifier).
 */

import { createHash, randomBytes } from 'crypto';
import type { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';
/** Both hostnames are documented; twitter.com is widely used for token. */
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const USER_URLS = [
  'https://api.twitter.com/2/users/me?user.fields=username,name',
  'https://api.x.com/2/users/me?user.fields=username,name',
  'https://api.twitter.com/2/users/me',
  'https://api.x.com/2/users/me',
];
/**
 * tweet.read is required by X for user-context identity in practice, even when
 * we only read the profile. offline.access is optional; kept for longer sessions
 * if X grants it.
 */
const SCOPE = 'tweet.read users.read offline.access';
const PKCE_COOKIE = 'flizy_x_pkce';

function clientId(): string {
  return (process.env.X_OAUTH_CLIENT_ID || process.env.TWITTER_OAUTH_CLIENT_ID || '').trim();
}

function clientSecret(): string {
  return (process.env.X_OAUTH_CLIENT_SECRET || process.env.TWITTER_OAUTH_CLIENT_SECRET || '').trim();
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

export function mintPkce(): { verifier: string; challenge: string } {
  // 32–96 bytes recommended; 32 is fine and URL-safe after b64url
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Attach PKCE verifier to the authorize redirect so the browser stores it. */
export function attachPkceCookie(res: NextResponse, verifier: string): void {
  res.cookies.set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
}

/** Async since Next 15: cookies() returns a promise. Callers await it. */
export async function takePkceVerifier(): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(PKCE_COOKIE)?.value || null;
  try {
    jar.set(PKCE_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  } catch {
    /* ignore clear failure */
  }
  return v && v.length >= 16 ? v : null;
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

/** Structured failure so the callback can show a useful status (not only exchange_failed). */
export type XExchangeResult =
  | { ok: true; identity: XIdentity }
  | {
      ok: false;
      /** Mapped into ?x=… query for the Account UI */
      reason:
        | 'exchange_failed'
        | 'project_required'
        | 'unauthorized'
        | 'rate_limited';
    };

async function postToken(body: URLSearchParams, useBasic: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (useBasic) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`;
  }
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers,
    body,
    cache: 'no-store',
  });
}

/**
 * Exchange authorization code + PKCE verifier for the X user id + username.
 */
export async function exchangeCodeForIdentity(
  code: string,
  codeVerifier: string
): Promise<XExchangeResult> {
  try {
    // Confidential client (Web App): Basic auth, no client_id in body.
    const confidentialBody = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code_verifier: codeVerifier,
    });

    let tokenRes = await postToken(confidentialBody, true);
    let tokenText = await tokenRes.text();

    // Public client fallback: client_id in body (if portal app type is SPA/native)
    if (!tokenRes.ok) {
      console.error(
        `[oauth:x] confidential token exchange HTTP ${tokenRes.status}: ${tokenText.slice(0, 200)}`
      );
      const publicBody = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: clientId(),
        redirect_uri: redirectUri(),
        code_verifier: codeVerifier,
      });
      tokenRes = await postToken(publicBody, false);
      tokenText = await tokenRes.text();
    }

    if (!tokenRes.ok) {
      console.error(`[oauth:x] token exchange failed HTTP ${tokenRes.status}: ${tokenText.slice(0, 300)}`);
      return { ok: false, reason: 'exchange_failed' };
    }

    let tokenBody: {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    try {
      tokenBody = JSON.parse(tokenText);
    } catch {
      console.error('[oauth:x] token response was not JSON');
      return { ok: false, reason: 'exchange_failed' };
    }

    if (!tokenBody?.access_token) {
      console.error(
        `[oauth:x] no access_token: ${tokenBody?.error || 'unknown'} ${tokenBody?.error_description || ''}`
      );
      return { ok: false, reason: 'exchange_failed' };
    }

    let accessToken = tokenBody.access_token;

    // Some X apps issue tokens that only work after a refresh (known platform quirk).
    if (tokenBody.refresh_token) {
      try {
        const refreshBody = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenBody.refresh_token,
          client_id: clientId(),
        });
        let refreshRes = await postToken(refreshBody, true);
        if (!refreshRes.ok) {
          refreshRes = await postToken(refreshBody, false);
        }
        if (refreshRes.ok) {
          const refreshed = (await refreshRes.json()) as { access_token?: string };
          if (refreshed.access_token) accessToken = refreshed.access_token;
        }
      } catch {
        /* use original access token */
      }
    }

    let lastStatus = 0;
    let lastBody = '';
    for (const userUrl of USER_URLS) {
      const userRes = await fetch(userUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Flizy-App',
        },
        cache: 'no-store',
      });
      lastStatus = userRes.status;
      if (!userRes.ok) {
        lastBody = await userRes.text().catch(() => '');
        console.error(`[oauth:x] user read HTTP ${userRes.status} ${userUrl}: ${lastBody.slice(0, 200)}`);
        continue;
      }
      const payload = (await userRes.json()) as {
        data?: { id?: string; username?: string; name?: string };
      };
      const id = payload?.data?.id != null ? String(payload.data.id) : '';
      if (!/^\d+$/.test(id)) {
        console.error('[oauth:x] missing numeric id in /2/users/me');
        return { ok: false, reason: 'exchange_failed' };
      }
      const login = String(payload.data?.username || payload.data?.name || '').trim() || id;
      return { ok: true, identity: { externalId: id, login } };
    }

    console.error(`[oauth:x] all user reads failed last=${lastStatus}: ${lastBody.slice(0, 300)}`);
    // X Free / unenrolled apps often 403 with this "Project" wording even when the
    // app is already under a project in the portal.
    if (
      lastStatus === 403 &&
      /attached to a Project|developer App that is attached|not permitted|client-not-enrolled/i.test(
        lastBody
      )
    ) {
      return { ok: false, reason: 'project_required' };
    }
    if (lastStatus === 401 || lastStatus === 403) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (lastStatus === 429) {
      return { ok: false, reason: 'rate_limited' };
    }
    return { ok: false, reason: 'exchange_failed' };
  } catch (err) {
    console.error(`[oauth:x] exchange threw: ${(err as Error).message}`);
    return { ok: false, reason: 'exchange_failed' };
  }
}
