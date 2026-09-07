/**
 * Payment requests: ask a person for money.
 *
 * A request reaches whatever a send reaches -- a phone, a Flizy username, a
 * platform identity, an email -- and the payer sees it once that identity is
 * proven on their account. That is the same rule claims already follow, so
 * this deliberately reuses lib/claimRecipient.js rather than growing a second
 * way to address a person.
 *
 * The two tables disagree on prefix and always will: a claim is addressed
 * `to` someone, a request comes `from` them. The shared helpers speak `to_*`,
 * so the two adapters below rename at the boundary. That is cheaper than
 * forking the matching logic, which is the part that must never diverge.
 */

const { getSupabase } = require('./supabase');
const { normalizeWaHint, isPlausiblePhone } = require('./claims');
const { claimMatchKeysForAccount } = require('./phone');
const { displaySafeLabel } = require('./sanitize');
const {
  recipientColumns,
  recipientFromRow,
  recipientKeys,
  claimMatchesRecipient,
  claimRecipientLabel,
} = require('./claimRecipient');

/**
 * Ask a Flizy account directly.
 *
 * Claims have no equivalent, which is why this is not in claimRecipient.js: a
 * claim exists for someone who is not on Flizy yet, so it can only be
 * addressed to an identity. A request is aimed at someone who can be told,
 * and when they are already here their account is a stabler address than any
 * one identity on it -- they can unlink a Telegram and keep the account.
 *
 * @param {string} accountId
 * @param {string|null} [label] username as it read, for display only
 */
function accountRecipient(accountId, label = null) {
  if (!accountId) throw new Error('accountRecipient needs an account id');
  return { kind: 'account', accountId: String(accountId), label: label || null };
}

/** Recipient -> the columns this table stores it in. */
function requestRecipientColumns(recipient) {
  if (recipient?.kind === 'account') {
    return {
      from_account_id: recipient.accountId,
      from_wa_hint: null,
      from_channel: null,
      from_external_id: null,
      from_display_handle: recipient.label || null,
      from_email: null,
    };
  }
  const c = recipientColumns(recipient);
  return {
    from_account_id: null,
    from_wa_hint: c.to_wa_hint,
    from_channel: c.to_channel,
    from_external_id: c.to_external_id,
    from_display_handle: c.to_display_handle,
    from_email: c.to_email,
  };
}

/**
 * A request row wearing claim column names, so the shared matcher can read it.
 *
 * Only the recipient columns are renamed; everything else is left alone, so a
 * caller can still reach amount_eth and status on the result.
 */
function claimShaped(row) {
  if (!row) return row;
  return {
    ...row,
    to_wa_hint: row.from_wa_hint,
    to_channel: row.from_channel,
    to_external_id: row.from_external_id,
    to_display_handle: row.from_display_handle,
    to_email: row.from_email,
  };
}

/**
 * The recipient columns arrive in a hand-applied migration, so for a window
 * the code is deployed and the table is not. A query against a column that
 * does not exist yet fails with 42703; treat that as "this mode is not
 * available here" and carry on, so phone requests keep working and nobody
 * loses the pay menu waiting for a dashboard visit.
 *
 * Same shape as isMissingRelation in lib/channelBind.js, one level down: that
 * one tolerates a missing table, this one a missing column.
 */
function isMissingColumn(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42703' || /column .* does not exist/i.test(message);
}

/** How a request names the person it is aimed at, for a menu. */
function requestPayerLabel(row) {
  if (row.from_account_id) {
    const handle = row.from_display_handle || row.from_label || '';
    return handle ? `@${String(handle).replace(/^@+/, '')}` : 'a Flizy account';
  }
  const shaped = claimShaped(row);
  if (recipientFromRow(shaped)) return claimRecipientLabel(shaped);
  return row.from_label || 'unknown';
}

/**
 * @param {{
 *   requesterAccountId: string,
 *   requesterWa?: string,
 *   recipient: object,
 *   fromLabel?: string|null,
 *   amountEth: string|number,
 *   chainId: number,
 * }} p
 *   `recipient` comes from lib/claimRecipient.js -- phoneRecipient,
 *   platformRecipient or emailRecipient. The database enforces that exactly
 *   one addressing mode is set, so a row can never be found by two different
 *   people at once.
 */
async function createPaymentRequest(p) {
  const supabase = getSupabase();
  const columns = requestRecipientColumns(p.recipient);

  if (
    !columns.from_account_id &&
    !columns.from_wa_hint &&
    !columns.from_channel &&
    !columns.from_email
  ) {
    throw new Error('A request needs someone to ask. No recipient was resolved.');
  }
  if (columns.from_wa_hint && !isPlausiblePhone(columns.from_wa_hint)) {
    throw new Error('Invalid phone. Use country code digits, e.g. 2348012345678');
  }

  // Rendered to the payer as "+<number>". Only a real phone belongs here.
  const requesterWa = normalizeWaHint(p.requesterWa || '');
  const { data, error } = await supabase
    .from('payment_requests')
    .insert({
      requester_account_id: p.requesterAccountId,
      requester_wa: isPlausiblePhone(requesterWa) ? requesterWa : null,
      ...columns,
      from_label: p.fromLabel || null,
      // Rows created by one split share a bill_id. There is no bills table:
      // the total, the creator and the progress all derive from these rows.
      bill_id: p.billId || null,
      bill_note: p.billNote || null,
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
 * Uses every phone on the account, not only the active chat row — see
 * claimMatchKeysForAccount.
 *
 * @param {string | {
 *   waSenderId?: string,
 *   waPhone?: string|null,
 *   identities?: Array<{ phone_e164?: string|null }>,
 * }} identityOrSender
 */
/**
 * Requests this person can pay, across every identity they have proven.
 *
 * Mirrors listIncomingPending in lib/claims.js, including why the platform
 * lookup fetches on the id set and then matches exactly: filtering both
 * columns in one query cross-pairs them, so a GitHub id could pull an X row.
 */
async function listIncomingRequests(identityOrSender) {
  const identity =
    typeof identityOrSender === 'string'
      ? { waSenderId: identityOrSender }
      : identityOrSender || {};

  const keys = recipientKeys({
    phones: claimMatchKeysForAccount(identity),
    identities: identity.identities || [],
    emails: identity.emails || [],
  });
  if (
    !identity.accountId &&
    !keys.phones.length &&
    !keys.identities.length &&
    !keys.emails.length
  ) {
    return [];
  }

  const supabase = getSupabase();
  const found = new Map();
  const base = () =>
    supabase
      .from('payment_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

  if (identity.accountId) {
    const { data, error } = await base().eq('from_account_id', identity.accountId);
    if (error && !isMissingColumn(error)) throw new Error(error.message);
    for (const row of data || []) found.set(row.id, row);
  }

  if (keys.phones.length) {
    const q =
      keys.phones.length === 1
        ? base().eq('from_wa_hint', keys.phones[0])
        : base().in('from_wa_hint', keys.phones);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const row of data || []) found.set(row.id, row);
  }

  if (keys.identities.length) {
    const { data, error } = await base()
      .in('from_channel', [...new Set(keys.identities.map((i) => i.channel))])
      .in('from_external_id', keys.identities.map((i) => i.externalId));
    if (error && !isMissingColumn(error)) throw new Error(error.message);
    for (const row of data || []) {
      if (claimMatchesRecipient(claimShaped(row), keys)) found.set(row.id, row);
    }
  }

  if (keys.emails.length) {
    const q =
      keys.emails.length === 1
        ? base().eq('from_email', keys.emails[0])
        : base().in('from_email', keys.emails);
    const { data, error } = await q;
    if (error && !isMissingColumn(error)) throw new Error(error.message);
    for (const row of data || []) {
      if (claimMatchesRecipient(claimShaped(row), keys)) found.set(row.id, row);
    }
  }

  return [...found.values()]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 50);
}

/**
 * Take exclusive ownership of a pending request before any money moves.
 * Exactly one of two racing payers gets the row back; the other gets null and
 * must not send.
 *
 * @param {string} id
 * @returns {Promise<object|null>} the request row when won, null when lost
 */
async function beginRequestProcessing(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('payment_requests')
    .update({ status: 'processing' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Reopen a request after a payment attempt that never reached the chain.
 * Never call this once a transfer has been submitted.
 *
 * @param {string} id
 */
async function releaseRequestProcessing(id) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('payment_requests')
    .update({ status: 'pending' })
    .eq('id', id)
    .eq('status', 'processing');
  if (error) throw new Error(error.message);
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

/**
 * Settle a request the caller already holds via beginRequestProcessing.
 */
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
    .eq('status', 'processing')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * @param {Array<object>} rows
 * @param {'outgoing'|'incoming'} mode
 */
/**
 * Body sent to the requester when someone pays their open request.
 * Delivered on every linked channel (WA + TG) via notifyAccount.
 *
 * @param {{
 *   amountEth: string|number,
 *   fromLabel?: string|null,
 *   explorerUrl?: string|null,
 * }} p
 */
function formatRequestPaidNotice(p) {
  const amount = String(p.amountEth ?? '').trim() || '?';
  const from = String(p.fromLabel || '').trim() || 'someone';
  const lines = [
    'Payment received on Flizy.',
    `${amount} ETH from ${from}.`,
    '',
    'It is in your Flizy wallet.',
  ];
  if (p.explorerUrl) {
    lines.push('', String(p.explorerUrl));
  }
  return lines.join('\n');
}

/**
 * Progress on each split in these rows.
 *
 * Derived, never stored. The total is the sum of the rows, the outstanding
 * count is a filter over them, and neither can disagree with the requests it
 * describes -- which is the reason there is no bills table.
 *
 * @param {object[]} rows
 * @returns {Array<{ billId: string, note: string|null, total: number, paid: number, open: number }>}
 */
function summarizeBills(rows) {
  const bills = new Map();
  for (const r of rows || []) {
    if (!r.bill_id) continue;
    const b = bills.get(r.bill_id) || {
      billId: r.bill_id,
      note: r.bill_note || null,
      total: 0,
      paid: 0,
      open: 0,
    };
    b.total += 1;
    if (String(r.status) === 'paid') b.paid += 1;
    if (String(r.status) === 'pending') b.open += 1;
    bills.set(r.bill_id, b);
  }
  return [...bills.values()];
}

function formatRequestsMenu(rows, mode = 'incoming') {
  if (!rows.length) {
    return mode === 'incoming'
      ? [
          'No payment requests for you.',
          'Someone can: {{cmd:request 0.01 from @you}}',
          '',
          'Share your number once so phone requests match this chat: {{cmd:phone}}',
        ].join('\n')
      : 'No open requests.\nCreate: {{cmd:request 0.01 from @someone}}';
  }
  const lines = [
    mode === 'incoming' ? 'Pay these requests' : 'Your open requests (cancel anytime)',
    '',
  ];

  if (mode !== 'incoming') {
    for (const b of summarizeBills(rows)) {
      const label = b.note ? displaySafeLabel(b.note) : 'Split';
      lines.push(`${label}: ${b.paid} of ${b.total} paid`);
    }
    if (summarizeBills(rows).length) lines.push('');
  }
  rows.forEach((r, i) => {
    const peer =
      mode === 'incoming'
        ? r.requester_wa
          ? `+${r.requester_wa}`
          : 'someone'
        : requestPayerLabel(r);
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
  accountRecipient,
  summarizeBills,
  // Exported for its own test: this mapper is what guarantees a row can never
  // carry two addressing modes, which is the property the database constraint
  // and the whole match path depend on.
  requestRecipientColumns,
  createPaymentRequest,
  getPaymentRequestById,
  listOutgoingRequests,
  listIncomingRequests,
  beginRequestProcessing,
  releaseRequestProcessing,
  cancelPaymentRequest,
  markRequestPaid,
  formatRequestsMenu,
  formatRequestPaidNotice,
};
