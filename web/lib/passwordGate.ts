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
