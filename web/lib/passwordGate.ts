/**
 * Password re-auth for a route that changes a credential.
 *
 * Same gate, same responses, as the inline one in app/api/trusted/route.ts:
 * 400 with no password, 401 when it is wrong, 400 when the account has no
 * password hash to check against. It sits here rather than inside a route file
 * because two callers need it and because a Next route module may only export
 * HTTP handlers, so an inline copy cannot be unit tested. The supabase client is
 * passed in for the same reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extension: this module is also loaded straight by node --test,
// which does not resolve an extensionless relative specifier.
import { verifyPassword } from './cryptoPin.ts';

export type PasswordGateResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

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
  if (!verifyPassword(password, data.password_hash)) {
    return { ok: false, status: 401, error: 'Incorrect password' };
  }
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
