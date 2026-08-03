/**
 * Discord OAuth2 (authorization code). Plain fetch, no SDK.
 * Scope: identify — immutable snowflake id + username for display.
 * Token is discarded after the user read. Never store it.
 */

const AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/users/@me';
const SCOPE = 'identify';

function clientId(): string {
  return process.env.DISCORD_OAUTH_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.DISCORD_OAUTH_CLIENT_SECRET || '';
}

export function redirectUri(): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  return `${base}/api/auth/discord/callback`;
}

export function discordOAuthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && redirectUri().startsWith('http'));
}

export function discordAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
    prompt: 'consent',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type DiscordIdentity = {
  externalId: string;
  login: string;
};

export async function exchangeCodeForIdentity(code: string): Promise<DiscordIdentity | null> {
  try {
    const body = new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
    });

    if (!tokenRes.ok) {
      console.error(`[oauth:discord] token exchange failed: HTTP ${tokenRes.status}`);
      return null;
    }

    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody?.access_token) {
      console.error(`[oauth:discord] no token: ${tokenBody?.error || 'unknown'}`);
      return null;
    }

    const userRes = await fetch(USER_URL, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      cache: 'no-store',
    });

    if (!userRes.ok) {
      console.error(`[oauth:discord] user read failed: HTTP ${userRes.status}`);
      return null;
    }

    const user = (await userRes.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
    };
    const id = user?.id != null ? String(user.id) : '';
    if (!/^\d{5,30}$/.test(id)) {
      console.error('[oauth:discord] missing snowflake id');
      return null;
    }

    const login = String(user.global_name || user.username || '').trim() || id;
    return { externalId: id, login };
  } catch (err) {
    console.error(`[oauth:discord] exchange threw: ${(err as Error).message}`);
    return null;
  }
}
