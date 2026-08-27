/**
 * Per-account lock for site money routes. Mirrors lib/accountTxLock.js.
 * Service-role RPC only. Anon cannot take or drop the lock.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const LOCK_BUSY = 'A payment is already in progress from this account.';
export const LOCK_UNAVAILABLE = 'Could not start this payment. Try again shortly.';

export async function tryAccountTxLock(
  supabase: SupabaseClient,
  accountId: string,
  kind = 'tx'
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!accountId) return { ok: false, error: LOCK_UNAVAILABLE };
  try {
    const { data, error } = await supabase.rpc('try_account_tx_lock', {
      p_account_id: accountId,
      p_kind: String(kind || 'tx'),
    });
    if (error) {
      console.error('try_account_tx_lock:', error.message);
      return { ok: false, error: LOCK_UNAVAILABLE };
    }
    if (data !== true) return { ok: false, error: LOCK_BUSY };
    return { ok: true };
  } catch (err) {
    console.error(
      'try_account_tx_lock:',
      err instanceof Error ? err.message : err
    );
    return { ok: false, error: LOCK_UNAVAILABLE };
  }
}

export async function releaseAccountTxLock(
  supabase: SupabaseClient,
  accountId: string
): Promise<void> {
  if (!accountId) return;
  try {
    const { error } = await supabase.rpc('release_account_tx_lock', {
      p_account_id: accountId,
    });
    if (error) console.error('release_account_tx_lock:', error.message);
  } catch (err) {
    console.error(
      'release_account_tx_lock:',
      err instanceof Error ? err.message : err
    );
  }
}
