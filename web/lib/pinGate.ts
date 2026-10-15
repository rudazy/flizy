/**
 * Check the account's unlock PIN, typed on a flizy.app page.
 *
 * The PIN is never taken in chat. It is typed here: on the chat approval page
 * (web/app/api/approvals/[token]) today, and for web payments next. One
 * counter per account (loginAttempts.ts pinKey) on the same ladder as every
 * other secret: 4 free tries, then 1 minute, 5, 15, an hour, and a day for
 * each further miss. Setting a new PIN with the password clears it
 * (clearPinLockout, called by POST /api/pin).
 *
 * A locked counter refuses before the PIN is compared, so a guess made while
 * locked tells the guesser nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extensions: this module is also loaded straight by node --test.
import { verifyPin } from './cryptoPin.ts';
import { clearFailures, lockState, pinKey, recordFailure } from './loginAttempts.ts';

/** Misses allowed before the first pause (the ladder's FREE_ATTEMPTS). */
const FREE_TRIES = 4;

export type PinCheck =
  | { ok: true }
  | { ok: false; reason: 'no_pin'; status: 400; error: string }
  | { ok: false; reason: 'bad_format'; status: 400; error: string }
  | { ok: false; reason: 'wrong'; status: 401; error: string; attemptsLeft: number }
  | { ok: false; reason: 'locked'; status: 429; error: string; retryAfterText: string };

function lockedMessage(retryAfterText: string): string {
  return `Too many wrong PINs. Try again in about ${retryAfterText}, or set a new PIN on the site with your password.`;
}

export async function checkPin(supabase: SupabaseClient, accountId: string, pin: string): Promise<PinCheck> {
  const key = pinKey(accountId);
  const lock = await lockState(supabase, key);
  if (lock.locked && lock.retryAfterText) {
    return { ok: false, reason: 'locked', status: 429, error: lockedMessage(lock.retryAfterText), retryAfterText: lock.retryAfterText };
  }

  if (!/^\d{4,12}$/.test(String(pin || ''))) {
    return { ok: false, reason: 'bad_format', status: 400, error: 'Enter your PIN: 4 to 12 digits.' };
  }

  const { data, error } = await supabase.from('accounts').select('unlock_pin_hash').eq('id', accountId).maybeSingle();
  if (error) throw new Error(`pin read failed: ${error.message}`);
  if (!data?.unlock_pin_hash) {
    return { ok: false, reason: 'no_pin', status: 400, error: 'This account has no PIN yet. Set one on the site under Account.' };
  }

  if (!verifyPin(pin, String(data.unlock_pin_hash))) {
    const recorded = await recordFailure(supabase, key);
    if (recorded.retryAfterText) {
      return { ok: false, reason: 'locked', status: 429, error: lockedMessage(recorded.retryAfterText), retryAfterText: recorded.retryAfterText };
    }
    const attemptsLeft = Math.max(0, FREE_TRIES + 1 - recorded.attempts);
    return {
      ok: false,
      reason: 'wrong',
      status: 401,
      error: attemptsLeft === 1 ? 'Wrong PIN. One more miss pauses PIN entry for a while.' : 'Wrong PIN.',
      attemptsLeft,
    };
  }

  await clearFailures(supabase, key);
  return { ok: true };
}

/** Lift the PIN pause. Only the password-checked PIN reset may call this. */
export async function clearPinLockout(supabase: SupabaseClient, accountId: string): Promise<void> {
  await clearFailures(supabase, pinKey(accountId));
}
