/**
 * CSRF state for the OAuth round trip.
 *
 * Without a state value bound to the session, an attacker can hand a victim a
 * callback URL carrying the attacker's authorization code and attach the
 * attacker's GitHub to the victim's account, or the reverse. This bind decides
 * where money can later be routed, so the check is not optional.
 *
 * Stateless: no table, no row to clean up. The signature covers the payload and
 * the current session, so a state minted for one session cannot be replayed in
 * another.
 *
 * The session is NOT in the payload. The state travels through GitHub and comes
 * back in a query string, which lands in provider logs, browser history and any
 * Referer header. Instead the session key is mixed into the HMAC input only, so
 * a state issued under a different session simply fails to verify and nothing
 * session-derived is ever transmitted.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

/** Ten minutes is long enough for a slow OAuth consent and short enough to matter. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Is the signing secret present and long enough?
 *
 * Routes check this up front so a missing secret reads as "linking is not
 * available" rather than surfacing as a generic failure from deep inside the
 * verify path.
 */
export function oauthStateConfigured(): boolean {
  const secret = process.env.OAUTH_STATE_SECRET;
  return Boolean(secret && secret.length >= 32);
}

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || secret.length < 32) {
    // Deliberately not falling back to another secret. WALLET_DERIVATION_SECRET
    // derives money-holding private keys, and widening where it is used widens
    // the blast radius of the one key that must never leak.
    throw new Error('OAUTH_STATE_SECRET is required (32+ chars) for the OAuth state signature');
  }
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Buffer {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadB64: string, sessionKey: string): string {
  return b64url(createHmac('sha256', stateSecret()).update(`${payloadB64}.${sessionKey}`).digest());
}

/**
 * Mint a state value for the session behind the current cookie.
 * @param sessionKey sha256 of the session token, never the token itself
 */
export function createOAuthState(sessionKey: string): string {
  if (!sessionKey) throw new Error('createOAuthState: missing sessionKey');
  const payload = {
    n: randomBytes(16).toString('hex'),
    e: Date.now() + STATE_TTL_MS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${sign(payloadB64, sessionKey)}`;
}

export type StateCheck =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a state value against the session making the callback request.
 *
 * Any failure is a rejection. A mismatched signature and a mismatched session
 * are indistinguishable by design: the session key is an HMAC input, so the
 * wrong session produces the wrong signature.
 */
export function verifyOAuthState(state: string, sessionKey: string): StateCheck {
  if (!state || !sessionKey) return { ok: false, reason: 'malformed' };

  const parts = String(state).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };

  const [payloadB64, signature] = parts;

  const expected = sign(payloadB64, sessionKey);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: { n?: string; e?: number };
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!payload || typeof payload.e !== 'number') return { ok: false, reason: 'malformed' };
  if (payload.e < Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true };
}
