/**
 * Per-IP cap on account creation.
 *
 * POST /api/auth/signup is the only unauthenticated route that both writes a
 * row and sends mail to an address the caller chose. Without a cap it is an
 * open relay: post a victim's address, get a Flizy verification code delivered
 * to them, repeat. The per-account limits in emailVerify.ts cannot see this,
 * because every attempt mints the account they are keyed on.
 *
 * Database-backed for the reason spelled out in callbackLimiter.ts and
 * swapRateLimit.ts: a Map in module scope enforces nothing on Vercel, where
 * each serverless instance holds its own copy and a caller spread across
 * instances is never counted.
 *
 * The counting itself is one SQL statement (bump_signup_attempts) rather than a
 * read followed by a write. Select-then-upsert lets two concurrent requests
 * both read max - 1 and both pass, and the whole point of a signup cap is that
 * it holds against a caller firing in parallel.
 *
 * This is NOT the lockout ladder that login, PIN and link codes climb. Those
 * count wrong guesses and reset on a right one. Here a successful signup is the
 * abuse, so every attempt counts and nothing resets it but time.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extension: this module is also loaded straight by node --test,
// which does not resolve an extensionless relative specifier.
import { formatWait } from './channelBind.ts';

export const SIGNUP_RATE_LIMITED = 'SIGNUP_RATE_LIMITED';

export const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

const DEFAULT_MAX_PER_WINDOW = 5;

/**
 * Signups allowed per IP per rolling hour. Override with SIGNUP_MAX_PER_HOUR.
 * A non-numeric or non-positive value falls back to the default rather than
 * disabling the cap, so a typo in the env cannot quietly remove it.
 */
export function signupsPerWindow(): number {
  const raw = Number(process.env.SIGNUP_MAX_PER_HOUR);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_PER_WINDOW;
  return Math.floor(raw);
}

/**
 * Client address for the request, as a hash.
 *
 * `x-real-ip` first: Vercel's proxy sets it to the single client address and
 * does not pass through a client-supplied one. `x-forwarded-for` is the
 * fallback, and the LAST entry is taken rather than the first, because entries
 * are appended as a request passes through proxies and the one nearest us is
 * the one we can believe. Reading the first entry would let a caller pick their
 * own bucket by sending the header themselves.
 *
 * Hashed so the column is not a plaintext list of addresses. Do not read more
 * into that than it earns: IPv4 is 2^32 values, so a plain digest is reversible
 * by anyone who wants to spend a few seconds on it, and this is not
 * anonymisation. It is a counter key that happens not to be legible at a
 * glance. Anyone who can read this table holds the service role and has worse
 * things available to them already.
 *
 * An address we cannot read at all shares one bucket, which is the right
 * failure: local runs and any future non-Vercel host stay capped, not uncapped.
 */
export function signupIpKey(headers: Headers): string {
  const real = (headers.get('x-real-ip') || '').trim();
  let ip = real;

  if (!ip) {
    const forwarded = headers.get('x-forwarded-for') || '';
    const parts = forwarded
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    ip = parts.length ? parts[parts.length - 1] : '';
  }

  return createHash('sha256').update(ip || 'unknown').digest('hex');
}

function isMissingObject(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '');
  return (
    code === '42P01' ||
    code === '42883' ||
    code === 'PGRST202' ||
    code === 'PGRST205' ||
    /does not exist/i.test(message) ||
    /bump_signup_attempts/.test(message)
  );
}

export type SignupRateResult =
  | { ok: true; used: number; max: number; degraded: boolean }
  | { ok: false; status: number; error: string; code: string; used: number; max: number };

/**
 * Count this attempt and say whether it may proceed.
 *
 * Call once, immediately before the insert. It is not a read: calling it twice
 * charges the caller twice.
 *
 * A missing migration degrades open with a loud warning, matching every other
 * limiter here. That is weaker than refusing, and it is only defensible because
 * web/scripts/verify-schema.mjs now blocks a deploy whose migrations have not
 * landed, so the missing-table case cannot reach production. What remains is a
 * transient database error, where refusing every signup would be the worse
 * outcome. The honeypot and the address check in the route do not depend on
 * this and still apply.
 */
export async function checkSignupRateLimit(
  supabase: SupabaseClient,
  ipKey: string
): Promise<SignupRateResult> {
  const max = signupsPerWindow();

  const { data, error } = await supabase.rpc('bump_signup_attempts', {
    p_ip_key: ipKey,
    p_window_ms: SIGNUP_WINDOW_MS,
    p_max: max,
  });

  if (error) {
    if (isMissingObject(error)) {
      console.warn(
        '[signup] bump_signup_attempts missing. Signup rate limiting is NOT active. Run migration 20260919000000_signup_attempts.sql'
      );
    } else {
      console.warn(`[signup] rate-limit call failed, cap NOT enforced: ${error.message}`);
    }
    return { ok: true, used: 0, max, degraded: true };
  }

  // The function returns a single row; PostgREST hands back an array for a
  // set-returning function and an object when it is called as a scalar.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed?: boolean; used?: number; retry_after_ms?: number | string }
    | undefined;

  if (!row) {
    console.warn('[signup] rate-limit call returned no row, cap NOT enforced');
    return { ok: true, used: 0, max, degraded: true };
  }

  const used = Number(row.used || 0);
  if (row.allowed) return { ok: true, used, max, degraded: false };

  // `??`, not `||`. A zero here is a value the counter gave us and it floors to
  // a second; `||` would read it as absent and quote a full hour instead.
  // PostgREST renders bigint as a string, hence the parse and the finite check.
  const raw = Number(row.retry_after_ms ?? SIGNUP_WINDOW_MS);
  const retryMs = Math.max(1000, Number.isFinite(raw) ? raw : SIGNUP_WINDOW_MS);

  return {
    ok: false,
    status: 429,
    error: `That is too many accounts from one place. Try again in ${formatWait(retryMs)}.`,
    code: SIGNUP_RATE_LIMITED,
    used,
    max,
  };
}
