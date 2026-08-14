/**
 * Remembered browser for login codes.
 *
 * Survives logout. Same browser within 30 days skips the email code.
 * A new browser, or a cookie older than 30 days, requires a code.
 */

import { createHmac } from 'crypto';

export const LOGIN_DEVICE_COOKIE = 'flizy_device';
export const LOGIN_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function deviceSecret(): string {
  return (
    process.env.OAUTH_STATE_SECRET ||
    process.env.EMAIL_CODE_SECRET ||
    process.env.WALLET_DERIVATION_SECRET ||
    ''
  );
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


