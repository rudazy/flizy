/**
 * Site session cookie.
 *
 * The cookie carries an opaque random token. The server stores only
 * sha256(token) in web_sessions, so the database never holds anything that can
 * be replayed as a session, and a session can actually be revoked.
 *
 * It used to carry the raw account id, which meant the "session" was an
 * unrevocable bearer token that was also an input to the agent wallet
 * derivation. Any cookie still holding an old raw id simply fails the lookup
 * and the user logs in again.
 */

import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'crypto';
import { getSupabase } from './supabase';

const COOKIE = 'flizy_session';
/** Cookie written by the pre-session build. Cleared on sight, never trusted. */
const LEGACY_COOKIE = 'flizy_account';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Start a session for an account and set the cookie.
 * Returns nothing useful on purpose: the token is for the browser only.
 */
export async function createSession(accountId: string): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const supabase = getSupabase();
  const { error } = await supabase.from('web_sessions').insert({
    account_id: accountId,
    token_hash: hashToken(token),
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw new Error(`Could not start session: ${error.message}`);

  const jar = cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    // Off in local dev, where Next serves plain http and a secure cookie would
    // never be stored. Always on in production.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  jar.set(LEGACY_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/**
 * Account id for the current request, or null when there is no live session.
 * Absolute expiry is enforced server side; the cookie maxAge is only a hint.
 */
export async function getAccountIdFromCookie(): Promise<string | null> {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('web_sessions')
    .select('account_id, expires_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.account_id;
}

/**
 * End the current session (server row and cookie).
 */
export async function clearAccountCookie(): Promise<void> {
  const jar = cookies();
  const token = jar.get(COOKIE)?.value;

  if (token) {
    try {
      const supabase = getSupabase();
      await supabase.from('web_sessions').delete().eq('token_hash', hashToken(token));
    } catch {
      // Cookie still gets cleared below; a stale row expires on its own.
    }
  }

  jar.set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  jar.set(LEGACY_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/**
 * Log an account out everywhere. Call from any future password reset or
 * recovery flow: changing a credential must not leave old sessions alive.
 */
export async function revokeAllSessions(accountId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('web_sessions').delete().eq('account_id', accountId);
  if (error) throw new Error(`Could not revoke sessions: ${error.message}`);
}
