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
 * Normalize row so inserts never fail on NOT NULL phone / missing extras.
 * @param {object} row
 */
function normalizeTransferRow(row) {
  const out = { ...row };
  if (out.phone == null || out.phone === '') {
    out.phone = 'wa';
  }
  if (out.status == null) out.status = 'pending';
  if (out.kind == null) out.kind = 'transfer';
  // amount_eth is numeric; ensure string/number present
  if (out.amount_eth == null || out.amount_eth === '') {
    out.amount_eth = '0';
  }
  return out;
}

/**
 * @param {object} row
 * @returns {Promise<{ id: string } | null>}
 */
async function insertTransfer(row) {
  const supabase = getSupabase();
  const payload = normalizeTransferRow(row);

  let { data, error } = await supabase.from('transfers').insert(payload).select('id').single();

  // Any failure: strip extended columns (asset, direction, …) and retry core shape
  if (error) {
    console.warn('transferLog insert (full) failed, retrying core:', error.message);
    const core = {};
    for (const k of CORE_KEYS) {
      if (payload[k] !== undefined && payload[k] !== null) core[k] = payload[k];
    }
    if (!core.phone) core.phone = 'wa';
    if (!core.status) core.status = 'pending';
    if (!core.to_address) core.to_address = '0x0000000000000000000000000000000000000000';
    const retry = await supabase.from('transfers').insert(core).select('id').single();
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error('transferLog insert failed:', error.message, {
      kind: payload.kind,
      account_id: payload.account_id,
      phone: payload.phone,
    });
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
    tx_hash: result.txHash || null,
    error: result.ok ? null : result.error || 'receipt status not successful',
  });
}

module.exports = {
  insertTransfer,
  updateTransfer,
  logSubmitted,
  logReceipt,
  normalizeTransferRow,
};
