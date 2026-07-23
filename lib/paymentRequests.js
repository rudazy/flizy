/**
 * Payment requests: "flizy request 0.01 from 234…" / from trusted name.
 * Payer only sees/pays after WhatsApp identity matches (same idea as claims).
 */

const { getSupabase } = require('./supabase');
const { normalizeWaHint, isPlausiblePhone } = require('./claims');
const { claimMatchKeys } = require('./phone');

/**
 * @param {{
 *   requesterAccountId: string,
 *   requesterWa?: string,
 *   fromWaHint?: string|null,
 *   fromLabel?: string|null,
 *   amountEth: string|number,
 *   chainId: number,
 * }} p
 */
async function createPaymentRequest(p) {
  const supabase = getSupabase();
  let fromWa = p.fromWaHint ? normalizeWaHint(p.fromWaHint) : null;
  if (fromWa && !isPlausiblePhone(fromWa)) {
    throw new Error('Invalid phone. Use country code digits, e.g. 2348012345678');
  }
  const { data, error } = await supabase
    .from('payment_requests')
    .insert({
      requester_account_id: p.requesterAccountId,
      requester_wa: p.requesterWa ? normalizeWaHint(p.requesterWa) : null,
      from_wa_hint: fromWa,
      from_label: p.fromLabel || null,
      amount_eth: p.amountEth,
      chain_id: p.chainId,
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getPaymentRequestById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Outgoing requests I created (awaiting someone to pay me). */
async function listOutgoingRequests(requesterAccountId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('requester_account_id', requesterAccountId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Incoming: someone asked this phone to pay.
 * Match on normalized phone (same join key as claims), not LID.
 *
 * @param {string | { waSenderId?: string, waPhone?: string|null }} identityOrSender
 */
async function listIncomingRequests(identityOrSender) {
  const identity =
    typeof identityOrSender === 'string'
      ? { waSenderId: identityOrSender }
      : identityOrSender || {};
  const keys = claimMatchKeys(identity);
  if (!keys.length) return [];

  const supabase = getSupabase();
  let q = supabase
    .from('payment_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (keys.length === 1) {
    q = q.eq('from_wa_hint', keys[0]);
  } else {
    q = q.in('from_wa_hint', keys);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function cancelPaymentRequest(id, requesterAccountId) {
  const supabase = getSupabase();
  const { data: row, error: fErr } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fErr) throw new Error(fErr.message);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.requester_account_id !== requesterAccountId) {
    return { ok: false, reason: 'not_owner' };
  }
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending', request: row };

  const { data, error } = await supabase
    .from('payment_requests')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, request: data };
}

async function markRequestPaid(id, paidByAccountId, paidTxHash) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('payment_requests')
    .update({
      status: 'paid',
      paid_by_account_id: paidByAccountId,
      paid_tx_hash: paidTxHash || null,
      paid_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * @param {Array<object>} rows
 * @param {'outgoing'|'incoming'} mode
 */
function formatRequestsMenu(rows, mode = 'incoming') {
  if (!rows.length) {
    return mode === 'incoming'
      ? 'No payment requests for you.\nSomeone can: flizy request 0.01 from YOUR_NUMBER'
      : 'No open requests.\nCreate: flizy request 0.01 from 2348012345678';
  }
  const lines = [
    mode === 'incoming' ? 'Pay these requests' : 'Your open requests (cancel anytime)',
    '',
  ];
  rows.forEach((r, i) => {
    const peer =
      mode === 'incoming'
        ? r.requester_wa
          ? `+${r.requester_wa}`
          : 'someone'
        : r.from_wa_hint
          ? `+${r.from_wa_hint}`
          : r.from_label || 'unknown';
    lines.push(`${i + 1}. ${r.amount_eth} ETH  ${mode === 'incoming' ? 'to pay' : 'from'} ${peer}`);
  });
  lines.push('');
  if (mode === 'incoming') {
    lines.push('Reply 1 / 2 / … or All to pay');
  } else {
    lines.push('Reply 1 / 2 / … or All to cancel');
  }
  lines.push('Or: cancel (close menu)');
  return lines.join('\n');
}

module.exports = {
  createPaymentRequest,
  getPaymentRequestById,
  listOutgoingRequests,
  listIncomingRequests,
  cancelPaymentRequest,
  markRequestPaid,
  formatRequestsMenu,
};
