/**
 * Password-guess lockout for site login and requirePassword.
 *
 * Same ladder as chat PIN and link codes (web/lib/channelBind.ts mirrors
 * lib/lockoutLadder.js). Three separate counters share the login_attempts
 * table, each under its own namespaced key:
 *
 *   - login, per (email, client address). A wrong guess locks that email for
 *     that address only, so a stranger who knows someone's email can no
 *     longer lock the owner out of signing in from anywhere else. Unknown
 *     addresses climb the same steps as registered ones: a 429 must not mean
 *     "that mailbox exists".
 *   - login, per client address across every email. Generous (IP_FREE_ATTEMPTS)
 *     and forgotten after IP_WINDOW_MS of quiet, so a shared office address
 *     is not punished for a few typos, while one address spraying passwords
 *     across many emails is stopped.
 *   - re-authentication, per account (requirePassword). Only a signed-in
 *     session reaches it, so knowing an email is no longer enough to block
 *     the owner's PIN, password or limit changes.
 *
 * The same table also holds a once-a-day mark per account for the notice
 * signup sends a verified owner (signupNoticeKey, onceWithin).
 *
 * A sign-in from a new browser also needs the code emailed to the account, so
 * a guessed password alone does not sign anyone in.
 *
 * Keys are sha256 of a namespaced string; the table never holds an address or
 * an email. Degrades to a warning when the table is missing, the same way
 * PIN/link do before their migrations land.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  lockoutMsForAttempts,
  formatWait,
  lockStateFrom,
} from './channelBind.ts';

const TABLE = 'login_attempts';

export const LOGIN_LOCKED = 'LOGIN_LOCKED';

/** Failures one client address may make across all emails before it locks. */
export const IP_FREE_ATTEMPTS = 30;

/** An address counter with no failure for this long starts again from zero. */
export const IP_WINDOW_MS = 60 * 60 * 1000;

export function loginLockedMessage(retryAfterText: string): string {
  return `Too many sign-in attempts. Try again in about ${retryAfterText}.`;
}

function hashKey(namespaced: string): string {
  return createHash('sha256').update(namespaced).digest('hex');
}

/** Login counter for one email from one client address. */
export function loginPairKey(email: string, ipKey: string): string {
  return hashKey(`login:${String(email || '').trim().toLowerCase()}|${ipKey}`);
}

/** Login counter for one client address across every email. */
export function loginIpKey(ipKey: string): string {
  return hashKey(`login-ip:${ipKey}`);
}

/** Re-authentication counter for one signed-in account. */
export function reauthKey(accountId: string): string {
  return hashKey(`reauth:${accountId}`);
}

/** The address ladder: the normal ladder, starting after IP_FREE_ATTEMPTS. */
export function ipLockoutMs(attempts: number): number {
  if (attempts <= IP_FREE_ATTEMPTS) return 0;
  // The normal ladder's first lock is its fifth attempt.
  return lockoutMsForAttempts(attempts - IP_FREE_ATTEMPTS + 4);
}

function isMissingTable(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ? String(error.code) : '';
  const message = error.message || '';
  return code === '42P01' || code === 'PGRST205' || new RegExp(TABLE).test(message);
}

function warnMissing(): void {
  console.warn(
    `[login] ${TABLE} missing. Password-guess lockout is NOT active. Run migration 20260827010000_login_attempts.sql`
  );
}

export type LoginLockState = {
  locked: boolean;
  until: string | null;
  remainingMs: number;
  retryAfterText: string | null;
  degraded: boolean;
};

type Row = { failed_attempts?: number; locked_until?: string | null; last_attempt_at?: string | null };

async function readRow(
  supabase: SupabaseClient,
  key: string
): Promise<{ row: Row | null; degraded: boolean }> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('email_key, failed_attempts, locked_until, last_attempt_at')
    .eq('email_key', key)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      warnMissing();
      return { row: null, degraded: true };
    }
    console.warn(`[login] attempt read failed: ${error.message}`);
    return { row: null, degraded: true };
  }
  return { row: data || null, degraded: false };
}

/** Whether the counter under key is locked right now. */
export async function lockState(supabase: SupabaseClient, key: string): Promise<LoginLockState> {
  const { row, degraded } = await readRow(supabase, key);
  const state = lockStateFrom(row?.locked_until);
  return {
    ...state,
    retryAfterText: state.locked ? formatWait(state.remainingMs) : null,
    degraded,
  };
}

/**
 * Count one failure under key.
 *
 * @param ladder lock length for a given failure count
 * @param windowMs when set, a counter whose last failure is older than this
 *   starts again from zero
 */
export async function recordFailure(
  supabase: SupabaseClient,
  key: string,
  ladder: (attempts: number) => number = lockoutMsForAttempts,
  windowMs?: number
): Promise<{ attempts: number; lockedForMs: number; retryAfterText: string | null }> {
  const { row, degraded } = await readRow(supabase, key);
  const stale =
    windowMs != null &&
    row?.last_attempt_at != null &&
    Date.now() - new Date(row.last_attempt_at).getTime() > windowMs;
  const attempts = (stale ? 0 : Number(row?.failed_attempts || 0)) + 1;
  const lockedForMs = ladder(attempts);
  const result = {
    attempts,
    lockedForMs,
    retryAfterText: lockedForMs > 0 ? formatWait(lockedForMs) : null,
  };

  if (degraded) {
    return { ...result, lockedForMs: 0, retryAfterText: null };
  }

  const payload = {
    email_key: key,
    failed_attempts: attempts,
    locked_until: lockedForMs > 0 ? new Date(Date.now() + lockedForMs).toISOString() : null,
    last_attempt_at: new Date().toISOString(),
  };

  const { error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'email_key' });
  if (error) {
    if (isMissingTable(error)) warnMissing();
    else console.warn(`[login] could not record failed attempt: ${error.message}`);
    return { ...result, lockedForMs: 0, retryAfterText: null };
  }
  return result;
}

/** Forget the counter under key. */
export async function clearFailures(supabase: SupabaseClient, key: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('email_key', key);
  if (error && !isMissingTable(error)) {
    console.warn(`[login] could not clear attempts: ${error.message}`);
  }
}

/** Key for "the owner was told someone tried to sign up with their address". */
export function signupNoticeKey(accountId: string): string {
  return hashKey(`signup-notice:${accountId}`);
}

/**
 * True at most once per windowMs for a key, and marks it used. For notices
 * a caller can trigger at will, so they cannot be turned into a mail flood.
 * A table that cannot be read or written answers false: a missed notice is
 * the safer failure than an unbounded one.
 */
export async function onceWithin(supabase: SupabaseClient, key: string, windowMs: number): Promise<boolean> {
  const { row, degraded } = await readRow(supabase, key);
  if (degraded) return false;
  if (row?.last_attempt_at && Date.now() - new Date(row.last_attempt_at).getTime() < windowMs) return false;
  const { error } = await supabase.from(TABLE).upsert(
    { email_key: key, failed_attempts: 0, locked_until: null, last_attempt_at: new Date().toISOString() },
    { onConflict: 'email_key' }
  );
  return !error;
}

/**
 * The login counters for one attempt: the (email, address) pair and the
 * address alone. Locked when either is.
 */
export async function loginLockState(
  supabase: SupabaseClient,
  email: string,
  ipKey: string
): Promise<LoginLockState> {
  const [pair, ip] = await Promise.all([
    lockState(supabase, loginPairKey(email, ipKey)),
    lockState(supabase, loginIpKey(ipKey)),
  ]);
  return pair.locked || !ip.locked ? pair : ip;
}

/** Count a failed login against both counters. Locked when either now is. */
export async function recordFailedLogin(
  supabase: SupabaseClient,
  email: string,
  ipKey: string
): Promise<{ attempts: number; lockedForMs: number; retryAfterText: string | null }> {
  const pair = await recordFailure(supabase, loginPairKey(email, ipKey));
  const ip = await recordFailure(supabase, loginIpKey(ipKey), ipLockoutMs, IP_WINDOW_MS);
  return pair.lockedForMs >= ip.lockedForMs ? pair : ip;
}

/**
 * A right password clears its own (email, address) counter. The address
 * counter is left to its window: clearing it on any success would let a
 * caller reset it by signing in to an account of their own between guesses.
 */
export async function clearFailedLogins(
  supabase: SupabaseClient,
  email: string,
  ipKey: string
): Promise<void> {
  await clearFailures(supabase, loginPairKey(email, ipKey));
}
