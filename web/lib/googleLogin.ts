/**
 * Server ticket for Google sign-in, and the decision of whether a profile
 * may open a Flizy session.
 *
 * The ticket is one httpOnly cookie: the PKCE verifier and the CSRF nonce.
 * The page cannot read it, and the OAuth state is signed against the nonce. A
 * callback that arrives without this cookie is refused.
 *
 * Google does not create an account. A verified Flizy account with this email
 * is signed in. Anything else goes back to the form with a fixed sentence.
 */

import { randomBytes } from 'crypto';
import { takeBudget } from './followRate.ts';
import { closureOf } from './accountClosure.ts';
import { safeNext } from './safeNext.ts';

export const GOOGLE_LOGIN_COOKIE = 'flizy_google_login';

const NONCE = /^[a-f0-9]{64}$/;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

const attempts = new Map<string, number[]>();

/** Ten tries per address per ten minutes, across start and callback. */
export function allowGoogleAttempt(key: string, now = Date.now()): boolean {
  return takeBudget(attempts, key, 10, 10 * 60 * 1000, now);
}

export type GoogleTicket = {
  nonce: string;
  verifier: string;
  next: string;
  back: '/login' | '/signup';
};

export function newGoogleNonce(): string {
  return randomBytes(32).toString('hex');
}

export function googleBack(raw: string | null | undefined): '/login' | '/signup' {
  return raw === 'signup' ? '/signup' : '/login';
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Buffer {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function packGoogleTicket(ticket: GoogleTicket): string {
  return b64url(Buffer.from(JSON.stringify(ticket), 'utf8'));
}

export function unpackGoogleTicket(raw: string | undefined | null): GoogleTicket | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const parsed = JSON.parse(fromB64url(raw).toString('utf8')) as Partial<GoogleTicket>;
    const nonce = String(parsed.nonce || '');
    const verifier = String(parsed.verifier || '');
    if (!NONCE.test(nonce) || !VERIFIER.test(verifier)) return null;
    return {
      nonce,
      verifier,
      next: safeNext(parsed.next),
      back: googleBack(parsed.back),
    };
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GoogleAccountRow = {
  id?: string | null;
  email_verified_at?: string | null;
  deleted_at?: string | null;
  deactivated_at?: string | null;
};

export type GoogleDecision =
  | { action: 'signin'; accountId: string; restore: boolean }
  | { action: 'reject'; reason: 'no_account' | 'unverified' };

/**
 * A Google profile may open a session only for the verified account on that
 * email. An unfinished signup stays unfinished: the password on that row was
 * typed before the inbox was proved.
 */
export function decideGoogleAccount(row: GoogleAccountRow | null | undefined): GoogleDecision {
  const id = String(row?.id || '');
  if (!UUID.test(id)) return { action: 'reject', reason: 'no_account' };
  if (!row?.email_verified_at) return { action: 'reject', reason: 'unverified' };
  return { action: 'signin', accountId: id, restore: closureOf(row) !== 'open' };
}
