/**
 * Password re-auth for a route that changes a credential or moves value.
 *
 * 400 with no password, 401 when it is wrong, 400 when the account has no
 * password hash to check against, 429 once the account's re-auth counter
 * locks (web/lib/loginAttempts.ts reauthKey, separate from sign-in). Every
 * such route calls this one gate (test/routeGuards.test.js lists them), and it
 * sits outside a route file because a Next route module may only export HTTP
 * handlers, so it could not be unit tested there. The supabase client is
 * passed in for the same reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extension: this module is also loaded straight by node --test,
// which does not resolve an extensionless relative specifier.
import { verifyPassword } from './cryptoPin.ts';
import {
  clearFailures,
  lockState,
  loginLockedMessage,
  LOGIN_LOCKED,
  reauthKey,
  recordFailure,
} from './loginAttempts.ts';

export type PasswordGateResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code?: string };

/**
 * @param supabase service-role client
 * @param accountId account from the session cookie, never from the body
 * @param password password as sent by the browser
 * @param action what it is being spent on, for the copy ("change your unlock PIN")
 */
export async function requirePassword(
  supabase: SupabaseClient,
  accountId: string,
  password: string,
  action: string
): Promise<PasswordGateResult> {
  if (!password) {
    return { ok: false, status: 400, error: `Password is required to ${action}` };
  }
  const { data, error } = await supabase
    .from('accounts')
    .select('password_hash')
    .eq('id', accountId)
    .single();
  if (error || !data?.password_hash) {
    return { ok: false, status: 400, error: 'Could not verify account' };
  }
  // Keyed on the account, not the email: only a signed-in session reaches
  // this, so a stranger who knows the email cannot lock the owner out of
  // their own PIN, password and limit changes, and the sign-in counters
  // (loginAttempts.ts) are untouched by what happens here.
  const key = reauthKey(accountId);
  const lock = await lockState(supabase, key);
  if (lock.locked && lock.retryAfterText) {
    return {
      ok: false,
      status: 429,
      error: loginLockedMessage(lock.retryAfterText),
      code: LOGIN_LOCKED,
    };
  }
  if (!verifyPassword(password, data.password_hash)) {
    const recorded = await recordFailure(supabase, key);
    if (recorded.retryAfterText) {
      return {
        ok: false,
        status: 429,
        error: loginLockedMessage(recorded.retryAfterText),
        code: LOGIN_LOCKED,
      };
    }
    return { ok: false, status: 401, error: 'Incorrect password' };
  }
  await clearFailures(supabase, key);
  return { ok: true };
}

/**
 * Lift the chat unlock lockout on every session this account has.
 *
 * The interlock with lib/session.js: the failed-PIN ladder there climbs to 24
 * hours, which is only safe because there is a way back in that does not
 * involve waiting it out. Proving the account password here is that way, and
 * setting or resetting the PIN is exactly that proof, so it also clears the
 * block. Do not make the ladder gentler and do not make this path cheaper
 * without reconsidering the other.
 *
 * Every channel is cleared, not just one: the person locked out does not know
 * which session row holds the block, and they have just authenticated.
 *
 * @returns false when the columns are not there yet (migration not applied) or
 *          the write failed. The PIN change itself still stands.
 */
export async function clearChatPinLockout(
  supabase: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('sessions')
    .update({ failed_pin_attempts: 0, pin_locked_until: null })
    .eq('account_id', accountId);
  if (error) {
    console.warn(`[pin] could not clear chat unlock lockout: ${error.message}`);
    return false;
  }
  return true;
}
