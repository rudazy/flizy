/**
 * Reliable transfer logging tied to submit + receipt (section 8).
 * Never store private keys or session secrets here.
 */

const { getSupabase } = require('./supabase');

/** Core columns that exist on older schemas */
const CORE_KEYS = [
  'user_id',
  'account_id',
  'phone',
  'to_address',
  'amount_eth',
  'tx_hash',
  'status',
  'error',
  'chain_id',
  'kind',
];

/**
 * @param {object} row
 * @returns {Promise<{ id: string } | null>}
 */
async function insertTransfer(row) {
  const supabase = getSupabase();
  // Prefer full row (asset / direction / secondary amounts). Fall back if migration not applied.
  let { data, error } = await supabase.from('transfers').insert(row).select('id').single();
  if (error && /column|schema cache/i.test(error.message || '')) {
    const core = {};
    for (const k of CORE_KEYS) {
      if (row[k] !== undefined) core[k] = row[k];
    }
    if (core.phone == null) core.phone = row.phone || 'site';
    const retry = await supabase.from('transfers').insert(core).select('id').single();
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    console.error('transferLog insert failed:', error.message);
    return null;
  }
  return data;
}

/**
 * @param {string | null | undefined} id
 * @param {object} patch
 */
async function updateTransfer(id, patch) {
  if (!id) {
    console.error('transferLog update skipped: missing id');
    return;
  }
  const supabase = getSupabase();
  const { error } = await supabase.from('transfers').update(patch).eq('id', id);
  if (error) {
    console.error('transferLog update failed:', error.message);
  }
}

/**
 * Full lifecycle helper: pending -> submitted (hash) -> confirmed|failed (receipt).
 */
async function logSubmitted(id, txHash) {
  await updateTransfer(id, {
    status: 'submitted',
    tx_hash: txHash,
  });
}

/**
 * @param {string | null | undefined} id
 * @param {{ ok: boolean, txHash: string, error?: string | null }} result
 */
async function logReceipt(id, result) {
  await updateTransfer(id, {
    status: result.ok ? 'confirmed' : 'failed',
    tx_hash: result.txHash,
    error: result.ok ? null : result.error || 'receipt status not successful',
  });
}

module.exports = {
  insertTransfer,
  updateTransfer,
  logSubmitted,
  logReceipt,
};
