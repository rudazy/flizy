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

const { ethers } = require('ethers');

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

/**
 * Columns back to a recipient -- the inverse of requestRecipientColumns.
 *
 * recipientFromRow covers only the three modes claims also have, because
 * account addressing is unique to requests. Anything that has to reach the
 * payer of a stored row goes through here rather than reading the columns.
 */
function requestRecipientFromRow(row) {
  if (!row) return null;
  if (row.from_account_id) {
    return accountRecipient(row.from_account_id, row.from_display_handle || row.from_label || null);
  }
  return recipientFromRow(claimShaped(row));
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
    throw new Error('Invalid phone. Use the international format, e.g. +234 708 043 7343');
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
 *
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
 * ETH amounts as wei, so nothing here is decided by float arithmetic.
 *
 * The first version of this subtracted with Number() and reported 0.03 minus
 * 0.01 as 0.019999999999999997. On a part-paid request that is not cosmetic: it
 * decides whether the last payment settles the row, and a request that can
 * never be settled cannot be closed.
 */
function toWei(amount) {
  try {
    return ethers.parseEther(String(amount ?? '0'));
  } catch {
    return 0n;
  }
}

/** How much of a request is still owed, as an ETH string, never below zero. */
function requestRemainingEth(row) {
  const left = toWei(row?.amount_eth) - toWei(row?.paid_amount_eth);
  return left > 0n ? ethers.formatEther(left) : '0';
}

/** True once every wei asked for has landed. */
function requestIsSettled(row) {
  return toWei(row?.paid_amount_eth) >= toWei(row?.amount_eth);
}

/**
 * How long an asker must wait before nudging the same request again.
 *
 * Six hours is a judgement, not a measurement: long enough that a reminder is
 * an event rather than a stream, short enough to catch someone the same day.
 * The limit exists because the nudge lands on somebody else's phone and they
 * did not ask for it.
 */
const REMIND_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Nudge the payer of an open request, at most once per cooldown.
 *
 * The timestamp is written before the caller sends anything, so a reminder that
 * fails to deliver still spends the window. That is deliberate: the alternative
 * is retrying on every failure, which turns a delivery problem into repeated
 * messages to a stranger.
 *
 * @returns {Promise<{ok: boolean, reason?: string, retryAfterMs?: number, request?: object}>}
 */
async function remindRequest(id, requesterAccountId, now = Date.now()) {
  const supabase = getSupabase();
  const { data: row, error: fErr } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fErr) throw new Error(fErr.message);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.requester_account_id !== requesterAccountId) return { ok: false, reason: 'not_owner' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending', request: row };

  const last = row.last_reminded_at ? new Date(row.last_reminded_at).getTime() : 0;
  const waited = now - last;
  if (last && waited < REMIND_COOLDOWN_MS) {
    return { ok: false, reason: 'too_soon', retryAfterMs: REMIND_COOLDOWN_MS - waited, request: row };
  }

  const { data, error } = await supabase
    .from('payment_requests')
    .update({ last_reminded_at: new Date(now).toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) {
    if (isMissingColumn(error)) return { ok: false, reason: 'unavailable', request: row };
    throw new Error(error.message);
  }
  return { ok: true, request: data };
}

/** Body the payer reads when they are nudged. */
function formatRequestReminderNotice(p) {
  // Both of these came from a person and are being shown to a different one.
  // bill_note especially: its column comment says to render it through
  // displaySafeLabel, because a newline inside it would forge extra lines of
  // what reads as a Flizy message.
  const who = displaySafeLabel(p.byLabel || 'someone');
  const lines = [`Reminder: ${who} is still waiting on ${p.amountEth} ETH.`];
  if (p.billNote) lines.push(`Split: ${displaySafeLabel(p.billNote)}`);
  lines.push('', 'Pay or refuse: {{cmd:pay}}');
  return lines.join('\n');
}

/**
 * Record money that landed against a request.
 *
 * Takes an amount because a payer may cover part of an ask. The status is not
 * told what to be: it follows the number, flipping to 'paid' only once
 * paid_amount_eth reaches amount_eth. A part payment returns the row to
 * 'pending' so the rest can still be paid, and so the row is still cancellable
 * and still counts as open on the bill.
 *
 * The caller must already hold the row via beginRequestProcessing: the update
 * is guarded on status 'processing', so a row nobody locked is left alone.
 *
 * @param {string|number} [amountEth] defaults to whatever is still owed, which
 *   is what the old full-payment callers meant.
 */
async function markRequestPaid(id, paidByAccountId, paidTxHash, amountEth) {
  const supabase = getSupabase();

  const { data: row, error: fErr } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fErr) throw new Error(fErr.message);
  if (!row) throw new Error('Request not found');

  const askedWei = toWei(row.amount_eth);
  const alreadyWei = toWei(row.paid_amount_eth);
  const addingWei = amountEth == null ? askedWei - alreadyWei : toWei(amountEth);
  // Never record more than was asked: the constraint would refuse it, and an
  // overpayment is a send rather than a payment against this row.
  const nowPaidWei =
    alreadyWei + (addingWei > 0n ? addingWei : 0n) > askedWei
      ? askedWei
      : alreadyWei + (addingWei > 0n ? addingWei : 0n);
  const settled = nowPaidWei >= askedWei;
  const nowPaid = ethers.formatEther(nowPaidWei);

  const patch = {
    paid_amount_eth: nowPaid,
    paid_by_account_id: paidByAccountId,
    paid_tx_hash: paidTxHash || null,
    // Back to pending when there is still something owed, so the rest can be
    // paid, the row stays cancellable, and the bill still counts it as open.
    status: settled ? 'paid' : 'pending',
    paid_at: settled ? new Date().toISOString() : null,
  };

  let { data, error } = await supabase
    .from('payment_requests')
    .update(patch)
    .eq('id', id)
    .eq('status', 'processing')
    .select('*')
    .single();

  // Before the migration lands there is no amount column; fall back to the
  // old all-or-nothing write rather than failing a payment that already moved.
  if (error && isMissingColumn(error)) {
    ({ data, error } = await supabase
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
      .single());
  }
  if (error) throw new Error(error.message);
  return data;
}

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
  // Someone else's label, printed for the requester. Same reasoning as the
  // decline and reminder notices below.
  const from = displaySafeLabel(p.fromLabel || 'someone');
  const lines = [
    'Payment received on Flizy.',
    `${amount} ETH from ${from}.`,
  ];
  // A part payment has to say so, or the requester reads "received" and
  // assumes the request is closed when most of it is still owed.
  if (p.remainingEth && Number(p.remainingEth) > 0) {
    lines.push(`${p.remainingEth} ETH still owed on this request.`);
  }
  lines.push('', 'It is in your Flizy wallet.');
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
      declined: 0,
      cancelled: 0,
    };
    b.total += 1;
    const status = String(r.status);
    // Every share lands in exactly one bucket. A declined share used to fall
    // through all of them, so the organiser saw a bill that never added up and
    // no sign that somebody had refused.
    if (status === 'paid') b.paid += 1;
    else if (status === 'declined') b.declined += 1;
    else if (status === 'cancelled') b.cancelled += 1;
    else b.open += 1;
    bills.set(r.bill_id, b);
  }
  return [...bills.values()];
}

/**
 * Every share of every bill this account created, whatever became of it.
 *
 * Deliberately not built from listOutgoingRequests. That returns pending rows
 * only, which is right for a menu of things you can still cancel and wrong for
 * a progress line: a paid share disappears from it, so `paid` could never be
 * anything but zero, and the bill appeared to shrink as people settled up.
 * Progress has to count the whole bill or it is not progress.
 */
async function summarizeBillsForAccount(requesterAccountId) {
  if (!requesterAccountId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('payment_requests')
    .select('bill_id, bill_note, status')
    .eq('requester_account_id', requesterAccountId)
    .not('bill_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingColumn(error)) return [];
    throw new Error(error.message);
  }
  return summarizeBills(data || []);
}

/** One "dinner: 1 of 3 paid, 1 declined" line per bill, in reading order. */
function billLines(bills) {
  return (bills || []).map(
    (b) => `${b.note ? displaySafeLabel(b.note) : 'Split'}: ${billProgressLine(b)}`
  );
}

/** "1 of 3 paid, 1 declined" -- the parts that are zero stay unsaid. */
function billProgressLine(b) {
  const parts = [`${b.paid} of ${b.total} paid`];
  if (b.declined) parts.push(`${b.declined} declined`);
  if (b.cancelled) parts.push(`${b.cancelled} cancelled`);
  if (b.open) parts.push(`${b.open} still open`);
  return parts.join(', ');
}

/**
 * Refuse a request that was addressed to you.
 *
 * The mirror of cancelPaymentRequest, and deliberately the opposite
 * authorization: that one checks requester_account_id, so only the asker may
 * withdraw. This one has to prove the caller is the person asked, which is not
 * a column comparison -- a request can be addressed by account, phone, platform
 * id or email, and the payer may hold any of those.
 *
 * Rather than reimplement that matching, it asks listIncomingRequests what this
 * identity can see and requires the row to be in it. One matcher, so a request
 * can never be declinable by someone who could not have paid it.
 *
 * @param {string} id
 * @param {object|string} identityOrSender same shape listIncomingRequests takes
 * @returns {Promise<{ok: boolean, reason?: string, request?: object}>}
 */
async function declinePaymentRequest(id, identityOrSender) {
  const supabase = getSupabase();

  const { data: row, error: fErr } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fErr) throw new Error(fErr.message);
  if (!row) return { ok: false, reason: 'not_found' };

  // Status first, then ownership, and that order is load-bearing:
  // listIncomingRequests only returns pending rows, so a settled request is
  // never in it. Asking about ownership first would answer "that was not
  // addressed to you" to the person who declined it a minute ago, which is both
  // false and the most common way to hit this path twice.
  //
  // The cost is that a settled row's status is readable by someone who was not
  // its recipient. That is not reachable: ids are UUIDs, and every caller passes
  // one the person already had in their own menu.
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending', request: row };

  const mine = await listIncomingRequests(identityOrSender);
  if (!mine.some((r) => r.id === id)) {
    return { ok: false, reason: 'not_yours', request: row };
  }

  const { data, error } = await supabase
    .from('payment_requests')
    .update({ status: 'declined', declined_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) {
    // The column and the widened status arrive in the same migration, so before
    // it is applied this fails rather than silently recording a cancellation.
    if (isMissingColumn(error)) return { ok: false, reason: 'unavailable', request: row };
    throw new Error(error.message);
  }
  return { ok: true, request: data };
}

/**
 * Body sent to the requester when the person they asked refuses.
 *
 * Names who refused, because on a split that is the only fact the organiser can
 * act on: one share is not coming, and they are the one who has to cover it or
 * ask somebody else. Says plainly that no money moved, so nobody goes looking
 * for a refund that never existed.
 */
function formatRequestDeclinedNotice(p) {
  const amount = String(p.amountEth ?? '').trim() || '?';
  // Both came from a person and are read by a different one. A newline inside
  // either would forge extra lines of what looks like a Flizy message, which is
  // why bill_note's column comment names displaySafeLabel by hand.
  const who = displaySafeLabel(p.byLabel || 'someone');
  const lines = [`${who} declined your request for ${amount} ETH.`];
  if (p.billNote) {
    lines.push(`Split: ${displaySafeLabel(p.billNote)}`);
  }
  lines.push('', 'Nothing moved. Their share is still open.');
  return lines.join('\n');
}

/**
 * @param {Array<object>} rows
 * @param {'outgoing'|'incoming'} mode
 */
function formatRequestsMenu(rows, mode = 'incoming', bills = []) {
  if (!rows.length) {
    return mode === 'incoming'
      ? [
          'No payment requests for you.',
          'Someone can: {{cmd:request 0.01 from @you}}',
          '',
          'Share your number once so phone requests match this chat: {{cmd:phone}}',
        ].join('\n')
      : [
          'No open requests.',
          // A settled bill is the answer to "did everyone pay me", so it
          // outlives the rows. Dropping it here meant the summary vanished at
          // the exact moment the organiser finally wanted to read it.
          ...billLines(bills),
          'Create: {{cmd:request 0.01 from @someone}}',
        ]
          .filter(Boolean)
          .join('\n');
  }
  const lines = [
    mode === 'incoming' ? 'Pay these requests' : 'Your open requests (cancel anytime)',
    '',
  ];

  // Passed in, never derived from `rows`: rows here are the pending ones the
  // reader can act on, and a bill's progress is a fact about all of its shares.
  if (mode !== 'incoming') {
    const bl = billLines(bills);
    if (bl.length) lines.push(...bl, '');
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
    lines.push('Or: decline 1');
  } else {
    lines.push('Reply 1 / 2 / … or All to cancel');
  }
  lines.push('Or: cancel (close menu)');
  return lines.join('\n');
}

module.exports = {
  accountRecipient,
  summarizeBills,
  summarizeBillsForAccount,
  billLines,
  billProgressLine,
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
  declinePaymentRequest,
  markRequestPaid,
  remindRequest,
  formatRequestReminderNotice,
  requestRemainingEth,
  requestIsSettled,
  requestRecipientFromRow,
  requestPayerLabel,
  formatRequestsMenu,
  formatRequestPaidNotice,
  formatRequestDeclinedNotice,
};
