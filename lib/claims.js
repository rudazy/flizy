/**
 * Claims: hold funds for someone until they prove who they are on Flizy.
 * Sender can cancel anytime while status = pending.
 * Recipient only sees/receives after that identity is proven.
 *
 * A claim is addressed exactly one of two ways:
 *   phone     to_wa_hint, proven by linking a chat channel that carries a phone
 *   platform  to_channel + to_external_id, proven by linking that platform
 *
 * Phone claims match via identity.phone_e164, never by LID alone. Platform
 * claims match on the immutable user id, never on the handle. The rules live in
 * lib/claimRecipient.js so they can be tested without a database.
 */

const crypto = require('crypto');
const { getSupabase } = require('./supabase');
const { config } = require('./config');
const {
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeys,
  claimMatchKeysForAccount,
} = require('./phone');
const {
  phoneRecipient,
  recipientColumns,
  recipientKeys,
  claimMatchesRecipient,
  claimRecipientLabel,
  recipientFromRow,
  channelLabel,
} = require('./claimRecipient');
const { displaySafeLabel } = require('./sanitize');

function newClaimToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** @deprecated Prefer normalizePhoneNumber from lib/phone. Same canonical form. */
function normalizeWaHint(raw) {
  return normalizePhoneNumber(raw);
}

/**
 * Pass either a recipient (preferred) or toWaHint (phone, back-compatible).
 *
 * @param {{
 *   fromAccountId: string,
 *   fromWaSender?: string,
 *   toWaHint?: string,
 *   recipient?: import('./claimRecipient').ClaimRecipient,
 *   amountEth: string|number,
 *   chainId: number,
 *   holdTxHash?: string|null,
 * }} p
 */
async function createClaim(p) {
  const supabase = getSupabase();
  // phoneRecipient throws the same message the phone-only path always threw, so
  // an invalid number still fails exactly where and how callers expect.
  const recipient = p.recipient || phoneRecipient(p.toWaHint);
  const claim_token = newClaimToken();
  // Shown to the recipient as the sender's number. Store nothing rather than
  // something that only looks like a phone (a chat user id, a namespaced key).
  const fromWaSender = normalizeWaHint(p.fromWaSender || '');
  const row = {
    from_account_id: p.fromAccountId,
    from_wa_sender: isPlausiblePhone(fromWaSender) ? fromWaSender : null,
    ...recipientColumns(recipient),
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
 * Incoming pending claims for a recipient, across both addressing modes.
 *
 * Phone keys keep coming from claimMatchKeys, whose precedence is deliberate
 * and is NOT re-derived here: when a real phone is known it is the only phone
 * key, and the raw sender id is used only as a legacy fallback. A WhatsApp LID
 * can be 15 digits, which passes a plausibility check, so treating it as a
 * phone alongside a known one could match a stranger's claim.
 *
 * @param {string | {
 *   waSenderId?: string,
 *   waPhone?: string|null,
 *   identities?: Array<{ channel: string, external_id?: string, externalId?: string }>,
 * }} identityOrSender
 *   A bare string is treated as waSenderId only (legacy).
 */
async function listIncomingPending(identityOrSender) {
  const identity =
    typeof identityOrSender === 'string'
      ? { waSenderId: identityOrSender }
      : identityOrSender || {};

  const keys = recipientKeys({
    // Account-wide phones: Telegram pay/claim must see requests addressed to
    // a phone stored on the WhatsApp identity of the same account.
    phones: claimMatchKeysForAccount(identity),
    identities: identity.identities || [],
  });

  if (!keys.phones.length && !keys.identities.length) return [];

  const supabase = getSupabase();
  const found = new Map();

  const base = () =>
    supabase
      .from('claims')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

  if (keys.phones.length) {
    let q = base();
    q = keys.phones.length === 1
      ? q.eq('to_wa_hint', keys.phones[0])
      : q.in('to_wa_hint', keys.phones);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const row of data || []) found.set(row.id, row);
  }

  if (keys.identities.length) {
    // Fetch on the id set, which the partial index covers, then apply the exact
    // (channel, id) match below. Filtering both columns in the query would
    // cross-pair them, so a github id could pull an x claim; and building an
    // or() string out of ids would put caller data into filter syntax.
    const { data, error } = await base()
      .in('to_channel', [...new Set(keys.identities.map((i) => i.channel))])
      .in('to_external_id', keys.identities.map((i) => i.externalId));
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      if (claimMatchesRecipient(row, keys)) found.set(row.id, row);
    }
  }

  return [...found.values()]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 50);
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
 * Take exclusive ownership of a pending claim before any money moves.
 *
 * This is the whole defence against a double payout. The update only matches
 * while the row is still 'pending', so of two callers racing the same claim
 * exactly one gets a row back and the other gets null. Whoever loses must not
 * touch the chain.
 *
 * @param {string} claimId
 * @returns {Promise<object|null>} the claim row when won, null when lost
 */
async function beginClaimProcessing(claimId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('claims')
    .update({ status: 'processing' })
    .eq('id', claimId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Hand a claim back after a failure that happened BEFORE anything was submitted
 * to the chain. Never call this once a transaction is in flight: the claim would
 * become payable again while the first transfer may still confirm.
 *
 * @param {string} claimId
 */
async function releaseClaimProcessing(claimId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('claims')
    .update({ status: 'pending' })
    .eq('id', claimId)
    .eq('status', 'processing');
  if (error) throw new Error(error.message);
}

/**
 * Cancel one claim the caller already owns (status only; refund on-chain first).
 * Expects the claim to be held in 'processing' by beginClaimProcessing.
 *
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
  if (row.status !== 'processing') return { ok: false, reason: 'not_pending', claim: row };

  const { data, error } = await supabase
    .from('claims')
    .update({
      status: 'cancelled',
      refund_tx_hash: refundTxHash || null,
      tx_hash: refundTxHash || row.tx_hash,
    })
    .eq('id', claimId)
    .eq('status', 'processing')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, claim: data };
}

/**
 * Mark claimed after payout (caller sends on-chain first).
 * Expects the claim to be held in 'processing' by beginClaimProcessing.
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
    .eq('status', 'processing')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * How the original send was addressed (so the sender is not confused).
 * Phone: "phone +234…". Platform: "GitHub @rudazy".
 *
 * @param {object} row claims row
 * @returns {string|null}
 */
function claimViaLine(row) {
  const r = recipientFromRow(row);
  if (!r) return null;
  if (r.kind === 'phone') {
    return r.phone ? `phone +${r.phone}` : 'phone';
  }
  const where = channelLabel(r.channel);
  if (r.displayHandle) {
    return `${where} @${displaySafeLabel(r.displayHandle)}`;
  }
  return `${where} user ${displaySafeLabel(r.externalId)}`;
}

/**
 * Body for the original sender when their claim is successfully claimed.
 * Delivered on every linked channel via notifyAccount.
 *
 * Always pairs (1) who claimed with (2) which hold this was, e.g. GitHub @user,
 * so a sender with many open claims is not confused.
 *
 * @param {{
 *   amountEth: string|number,
 *   byLabel?: string|null,
 *   viaLine?: string|null,
 *   forLabel?: string|null,
 *   explorerUrl?: string|null,
 * }} p
 */
function formatClaimClaimedNotice(p) {
  const amount = String(p.amountEth ?? '').trim() || '?';
  const by = String(p.byLabel || '').trim() || 'someone';
  const via = String(p.viaLine || p.forLabel || '').trim();
  const lines = [
    'Claim delivered on Flizy.',
    `${amount} ETH claimed by ${by}.`,
  ];
  if (via) {
    // Explicit "you sent this to …" ties the payout to the original address path
    lines.push(`You sent this to ${via}.`);
  }
  lines.push('', 'Funds left escrow for their agent wallet.');
  if (p.explorerUrl) {
    lines.push('', String(p.explorerUrl));
  }
  return lines.join('\n');
}

/**
 * Format list for WhatsApp cancel / claim menus.
 * @param {Array<object>} claims
 * @param {'outgoing'|'incoming'} mode
 */
function formatClaimsMenu(claims, mode = 'outgoing') {
  if (!claims.length) {
    return mode === 'outgoing'
      ? 'No pending claims.\nSend to a phone or GitHub: flizy send 0.001 to 234… | to @user on github'
      : 'No pending claims for you.';
  }
  const lines = [
    mode === 'outgoing' ? 'Your pending claims (cancel anytime)' : 'Claims waiting for you',
    '',
  ];
  claims.forEach((c, i) => {
    const amt = c.amount_eth;
    // Outgoing names whoever the claim is held for, in whichever way it was
    // addressed. Incoming names the sender, which is only ever a phone, and is
    // unknown whenever they never verified one: the "+" only goes on when there
    // is actually a number to put it in front of.
    const peer =
      mode === 'outgoing'
        ? claimRecipientLabel(c)
        : c.from_wa_sender
          ? `+${c.from_wa_sender}`
          : 'someone';
    const when = c.created_at ? new Date(c.created_at).toLocaleString() : '';
    lines.push(`${i + 1}. ${peer}  ${amt} ETH${when ? `  (${when})` : ''}`);
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
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeys,
  // Re-exported so callers get the recipient helpers from the claims module
  // rather than reaching past it.
  phoneRecipient,
  recipientKeys,
  claimMatchesRecipient,
  claimRecipientLabel,
  createClaim,
  getClaimByToken,
  getClaimById,
  listOutgoingPending,
  listIncomingPending,
  updateClaim,
  beginClaimProcessing,
  releaseClaimProcessing,
  cancelClaim,
  markClaimed,
  formatClaimsMenu,
  formatClaimClaimedNotice,
  claimViaLine,
};
