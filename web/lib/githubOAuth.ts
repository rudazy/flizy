/**
 * GitHub OAuth, by hand.
 *
 * Plain fetch, no SDK. The whole exchange is two POSTs and one GET, and an SDK
 * would add a dependency to web/ (which has six) for no benefit.
 *
 * The client secret lives here, server side only. Nothing in this module may be
 * imported into a client component: it would be bundled and shipped to the
 * browser. Every export is called from a route handler.
 *
 * We read exactly two fields from GitHub, the immutable numeric id and the
 * current login, and then discard the access token. No token is stored, no
 * scope is retained, and nothing is fetched on a schedule.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

/** Identity only. GitHub returns id and login on the authenticated user without
 * any scope, so none is requested: the smallest grant that does the job. */
const SCOPE = '';

function clientId(): string {
  return process.env.GITHUB_OAUTH_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.GITHUB_OAUTH_CLIENT_SECRET || '';
}

/**
 * The redirect_uri must match what is registered on the GitHub app character
 * for character, so it is built from one configured origin rather than from the
 * incoming request, which an attacker can influence via Host headers.
 */
export function redirectUri(): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  return `${base}/api/auth/github/callback`;
}

export function githubOAuthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && redirectUri().startsWith('http'));
}

export function githubAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    state,
    allow_signup: 'false',
  });
  if (SCOPE) params.set('scope', SCOPE);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type GithubIdentity = {
  /** Immutable numeric user id, as a string. This is what money routes on. */
  externalId: string;
  /** Current handle. Display only, never a match key. */
  login: string;
};

/**
 * Exchange the authorization code and read the identity behind it.
 *
 * Returns null on any provider failure. The caller maps that to one message:
 * distinguishing "bad code" from "GitHub is down" tells a prober more than it
 * helps a user.
 */
export async function exchangeCodeForIdentity(code: string): Promise<GithubIdentity | null> {
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        redirect_uri: redirectUri(),
      }),
      cache: 'no-store',
    });

    if (!tokenRes.ok) {
      console.error(`[oauth] token exchange failed: HTTP ${tokenRes.status}`);
      return null;
    }

    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    // GitHub answers 200 with an error field on a bad or replayed code.
    if (!tokenBody?.access_token) {
      console.error(`[oauth] token exchange returned no token: ${tokenBody?.error || 'unknown'}`);
      return null;
    }

    const userRes = await fetch(USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'flizy',
      },
      cache: 'no-store',
    });

    if (!userRes.ok) {
      console.error(`[oauth] user read failed: HTTP ${userRes.status}`);
      return null;
    }

    const user = (await userRes.json()) as { id?: number | string; login?: string };
    const id = user?.id;
    // A non-numeric id would mean GitHub changed its contract. Refuse rather
    // than store something that is not the immutable identifier.
    if (id === undefined || id === null || !/^\d+$/.test(String(id))) {
      console.error('[oauth] user payload had no numeric id');
      return null;
    }

    return { externalId: String(id), login: String(user?.login || '') };
  } catch (err) {
    console.error(`[oauth] exchange threw: ${(err as Error).message}`);
    return null;
  }
  // The access token goes out of scope here and is never persisted.
}
