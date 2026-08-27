/**
 * Password-guess lockout for site login and requirePassword.
 *
 * Same ladder as chat PIN and link codes (web/lib/channelBind.ts mirrors
 * lib/lockoutLadder.js). Keyed by sha256(email) so unknown addresses climb
 * the same steps as registered ones: a 429 must not mean "that mailbox exists".
 *
 * Degrades to a warning when the table is missing, the same way PIN/link do
 * before their migrations land. Paste 20260827010000_login_attempts.sql.
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

export function loginLockedMessage(retryAfterText: string): string {
  return `Too many sign-in attempts. Try again in about ${retryAfterText}.`;
}

export function loginEmailKey(email: string): string {
  return createHash('sha256')
    .update(String(email || '').trim().toLowerCase())
    .digest('hex');
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

async function readRow(
  supabase: SupabaseClient,
  emailKey: string
): Promise<{ row: { failed_attempts?: number; locked_until?: string | null } | null; degraded: boolean }> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('email_key, failed_attempts, locked_until')
    .eq('email_key', emailKey)
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

export async function loginLockState(
  supabase: SupabaseClient,
  email: string
): Promise<LoginLockState> {
  const key = loginEmailKey(email);
  if (!String(email || '').trim()) {
    return { locked: false, until: null, remainingMs: 0, retryAfterText: null, degraded: false };
  }
  const { row, degraded } = await readRow(supabase, key);
  const state = lockStateFrom(row?.locked_until);
  return {
    ...state,
    retryAfterText: state.locked ? formatWait(state.remainingMs) : null,
    degraded,
  };
}

export async function recordFailedLogin(
  supabase: SupabaseClient,
  email: string
): Promise<{ attempts: number; lockedForMs: number; retryAfterText: string | null }> {
  const key = loginEmailKey(email);
  const empty = { attempts: 0, lockedForMs: 0, retryAfterText: null };
  if (!String(email || '').trim()) return empty;

  const { row, degraded } = await readRow(supabase, key);
  const attempts = Number(row?.failed_attempts || 0) + 1;
  const lockedForMs = lockoutMsForAttempts(attempts);
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

export async function clearFailedLogins(
  supabase: SupabaseClient,
  email: string
): Promise<void> {
  const key = loginEmailKey(email);
  if (!String(email || '').trim()) return;
  const { error } = await supabase.from(TABLE).delete().eq('email_key', key);
  if (error && !isMissingTable(error)) {
    console.warn(`[login] could not clear attempts: ${error.message}`);
  }
}
