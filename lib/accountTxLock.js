/**
 * Per-account lock for site money routes (pay / swap / LP) and chat confirm.
 * Claims use pending -> processing on the claim row.
 */

const LOCK_BUSY = 'A payment is already in progress from this account.';
const LOCK_UNAVAILABLE = 'Could not start this payment. Try again shortly.';

/**
 * @param {{ rpc: Function }} supabase
 * @param {string} accountId
 * @param {string} [kind]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function tryAccountTxLock(supabase, accountId, kind = 'tx') {
  if (!accountId) return { ok: false, error: LOCK_UNAVAILABLE };
  let data;
  let error;
  try {
    const result = await supabase.rpc('try_account_tx_lock', {
      p_account_id: accountId,
      p_kind: String(kind || 'tx'),
    });
    data = result && result.data;
    error = result && result.error;
  } catch (err) {
    console.error('try_account_tx_lock:', err && err.message ? err.message : err);
    return { ok: false, error: LOCK_UNAVAILABLE };
  }
  if (error) {
    console.error('try_account_tx_lock:', error.message || error);
    return { ok: false, error: LOCK_UNAVAILABLE };
  }
  if (data !== true) return { ok: false, error: LOCK_BUSY };
  return { ok: true };
}

/**
 * @param {{ rpc: Function }} supabase
 * @param {string} accountId
 */
async function releaseAccountTxLock(supabase, accountId) {
  if (!accountId) return;
  try {
    const result = await supabase.rpc('release_account_tx_lock', {
      p_account_id: accountId,
    });
    if (result && result.error) {
      console.error('release_account_tx_lock:', result.error.message || result.error);
    }
  } catch (err) {
    console.error('release_account_tx_lock:', err && err.message ? err.message : err);
  }
}

module.exports = {
  tryAccountTxLock,
  releaseAccountTxLock,
  LOCK_BUSY,
  LOCK_UNAVAILABLE,
};
