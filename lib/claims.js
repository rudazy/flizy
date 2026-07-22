/**
 * Claims: hold funds for a WhatsApp number until that number links Flizy.
 * Sender can cancel anytime while status = pending.
 * Recipient only sees/receives after WhatsApp link (identity proof).
 */

const crypto = require('crypto');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

function newClaimToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Digits only, no +. Country code expected (e.g. 234…).
 * @param {string} raw
 */
function normalizeWaHint(raw) {
  return String(raw || '')
    .split('@')[0]
    .trim()
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

function isPlausiblePhone(digits) {
  const d = normalizeWaHint(digits);
  return d.length >= 10 && d.length <= 15;
}

/**
 * @param {{
 *   fromAccountId: string,
 *   fromWaSender?: string,
 *   toWaHint: string,
 *   amountEth: string|number,
 *   chainId: number,
 *   holdTxHash?: string|null,
 * }} p
 */
async function createClaim(p) {
  const supabase = getSupabase();
  const toWaHint = normalizeWaHint(p.toWaHint);
  if (!isPlausiblePhone(toWaHint)) {
    throw new Error('Invalid phone. Use country code digits, e.g. 2348012345678');
  }
  const claim_token = newClaimToken();
  const row = {
    from_account_id: p.fromAccountId,
    from_wa_sender: p.fromWaSender ? normalizeWaHint(p.fromWaSender) : null,
    to_wa_hint: toWaHint,
    amount_eth: p.amountEth,
    chain_id: p.chainId,
    claim_token,
    status: 'pending',
    hold_tx_hash: p.holdTxHash || null,
    tx_hash: p.holdTxHash || null,
  };
  const { data, error } = await supabase.from('claims').insert(row).select('*').single();
  if (error) throw new Error(error.message);

  const claimUrl = `${config.siteUrl}/claim/${claim_token}`;
  return { claim: data, claimUrl };
}

async function getClaimByToken(token) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .eq('claim_token', token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getClaimById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('claims').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Outgoing pending claims for a sender account (optional filter by phone digits).
 * @param {string} fromAccountId
 * @param {string} [toWaHintFilter]
 */
async function listOutgoingPending(fromAccountId, toWaHintFilter) {
  const supabase = getSupabase();
  let q = supabase
    .from('claims')
    .select('*')
    .eq('from_account_id', fromAccountId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (toWaHintFilter) {
    q = q.eq('to_wa_hint', normalizeWaHint(toWaHintFilter));
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Incoming pending claims for a WhatsApp id (only after they control this WA).
 * @param {string} waSenderId
 */
async function listIncomingPending(waSenderId) {
  const supabase = getSupabase();
  const hint = normalizeWaHint(waSenderId);
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .eq('to_wa_hint', hint)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * @param {string} claimId
 * @param {object} patch
 */
async function updateClaim(claimId, patch) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('claims')
    .update(patch)
    .eq('id', claimId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Cancel one pending claim (status only — caller must refund on-chain first).
 * @param {string} claimId
 * @param {string} fromAccountId must own the claim
 * @param {string} [refundTxHash]
 */
async function cancelClaim(claimId, fromAccountId, refundTxHash) {
  const supabase = getSupabase();
  const { data: row, error: fetchErr } = await supabase
    .from('claims')
    .select('*')
    .eq('id', claimId)
    .maybeSingle();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.from_account_id !== fromAccountId) return { ok: false, reason: 'not_owner' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending', claim: row };

  const { data, error } = await supabase
    .from('claims')
    .update({
      status: 'cancelled',
      refund_tx_hash: refundTxHash || null,
      tx_hash: refundTxHash || row.tx_hash,
    })
    .eq('id', claimId)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, claim: data };
}

/**
 * Mark claimed after payout (caller sends on-chain first).
 */
async function markClaimed(claimId, toAccountId, claimTxHash) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('claims')
    .update({
      status: 'claimed',
      to_account_id: toAccountId,
      claimed_at: new Date().toISOString(),
      claim_tx_hash: claimTxHash || null,
      tx_hash: claimTxHash || null,
    })
    .eq('id', claimId)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Format list for WhatsApp cancel / claim menus.
 * @param {Array<object>} claims
 * @param {'outgoing'|'incoming'} mode
 */
function formatClaimsMenu(claims, mode = 'outgoing') {
  if (!claims.length) {
    return mode === 'outgoing'
      ? 'No pending claims.\nSend to a phone: flizy send 0.001 to 2348012345678'
      : 'No pending claims for this WhatsApp.';
  }
  const lines = [
    mode === 'outgoing' ? 'Your pending claims (cancel anytime)' : 'Claims waiting for you',
    '',
  ];
  claims.forEach((c, i) => {
    const amt = c.amount_eth;
    const peer = mode === 'outgoing' ? c.to_wa_hint : c.from_wa_sender || 'someone';
    const when = c.created_at ? new Date(c.created_at).toLocaleString() : '';
    lines.push(`${i + 1}. +${peer}  ${amt} ETH${when ? `  (${when})` : ''}`);
  });
  lines.push('');
  if (mode === 'outgoing') {
    lines.push('Reply with number (1, 2, …) or All');
    lines.push('Or: cancel (close menu)');
  } else {
    lines.push('Reply with number (1, 2, …) or All to receive');
    lines.push('Or: cancel (close menu)');
  }
  return lines.join('\n');
}

module.exports = {
  newClaimToken,
  normalizeWaHint,
  isPlausiblePhone,
  createClaim,
  getClaimByToken,
  getClaimById,
  listOutgoingPending,
  listIncomingPending,
  updateClaim,
  cancelClaim,
  markClaimed,
  formatClaimsMenu,
};
