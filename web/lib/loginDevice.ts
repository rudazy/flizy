/**
 * Remembered browser for login codes.
 *
 * Cleared on logout. Same browser within 30 days skips the email code
 * while the cookie is present. A new browser, logout, or a cookie older
 * than 30 days, requires a code.
 */

import { createHmac } from 'crypto';

export const LOGIN_DEVICE_COOKIE = 'flizy_device';
export const LOGIN_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * HMAC key for the remembered-browser cookie.
 *
 * OAUTH_STATE_SECRET first (already required for GitHub linking), else
 * EMAIL_CODE_SECRET. Never WALLET_DERIVATION_SECRET: signing a cookie with
 * the wallet-derivation key widens the one secret that must never leak.
 * Missing secret means no cookie is written and every login needs a code.
 */
function deviceSecret(): string {
  const oauth = process.env.OAUTH_STATE_SECRET || '';
  if (oauth.length >= 32) return oauth;
  const email = process.env.EMAIL_CODE_SECRET || '';
  if (email.length >= 32) return email;
  return '';
}

function sign(body: string): string {
  const secret = deviceSecret();
  if (!secret) return '';
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function buildLoginDeviceValue(accountId: string, issuedAtMs: number): string {
  const id = String(accountId || '').trim();
  const issued = String(Math.floor(issuedAtMs));
  const body = `${id}.${issued}`;
  const sig = sign(body);
  if (!id || !sig) return '';
  return `${body}.${sig}`;
}

export function loginDeviceMatches(
  raw: string,
  accountId: string,
  nowMs = Date.now()
): boolean {
  const token = String(raw || '').trim();
  const id = String(accountId || '').trim();
  if (!token || !id || !deviceSecret()) return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0) return false;
  const body = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = sign(body);
  if (!expected || sig.length !== expected.length) return false;
  let same = 0;
  for (let i = 0; i < sig.length; i += 1) {
    same |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (same !== 0) return false;
  const sep = body.lastIndexOf('.');
  if (sep <= 0) return false;
  const tokenId = body.slice(0, sep);
  const issued = Number(body.slice(sep + 1));
  if (tokenId !== id) return false;
  if (!Number.isFinite(issued) || issued <= 0) return false;
  if (nowMs - issued > LOGIN_DEVICE_TTL_MS) return false;
  if (issued > nowMs + 60_000) return false;
  return true;
}


