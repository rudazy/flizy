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
 *
 * Google stands in for the password only. A browser Flizy does not remember
 * still takes the emailed login code, as a password sign-in does: the callback
 * sends the code and leaves a signed note (GOOGLE_PENDING_COOKIE) naming the
 * account, and /api/auth/google/verify opens the session once the code is right.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
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

export const GOOGLE_PENDING_COOKIE = 'flizy_google_pending';
/** As long as the emailed code lives. */
export const GOOGLE_PENDING_TTL_MS = 15 * 60 * 1000;

/** A Google sign-in waiting for its emailed code. */
export type GooglePending = {
  accountId: string;
  email: string;
  restore: boolean;
  next: string;
  issuedAt: number;
};

function pendingSig(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`google-pending.${body}`).digest();
}

/** Signed with OAUTH_STATE_SECRET, so the browser holds it but cannot change who it names. */
export function packGooglePending(p: GooglePending, secret: string): string {
  if (!secret || secret.length < 32) return '';
  const body = b64url(Buffer.from(JSON.stringify(p), 'utf8'));
  return `${body}.${b64url(pendingSig(body, secret))}`;
}

/** The note back, or null when it is missing, altered, malformed or older than the code. */
export function unpackGooglePending(raw: string | undefined | null, secret: string, now = Date.now()): GooglePending | null {
  if (!raw || raw.length > 2000 || !secret || secret.length < 32) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const given = fromB64url(raw.slice(dot + 1));
  const expected = pendingSig(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(fromB64url(body).toString('utf8')) as Partial<GooglePending>;
    const accountId = String(p.accountId || '');
    const email = String(p.email || '');
    const issuedAt = Number(p.issuedAt);
    if (!UUID.test(accountId) || !email.includes('@')) return null;
    if (!Number.isFinite(issuedAt) || now - issuedAt > GOOGLE_PENDING_TTL_MS || issuedAt > now + 60_000) return null;
    return { accountId, email, restore: p.restore === true, next: safeNext(p.next), issuedAt };
  } catch {
    return null;
  }
}
