const { getSupabase } = require('./supabase');
const { ethers } = require('ethers');
const { config } = require('./config');
const { formatWait } = require('./lockoutLadder');

/**
 * A destination is usable only when the owner has not cancelled it and its hold
 * has expired.
 *
 * `status` is the owner's decision, `active_at` is when the 24 hour hold ends.
 * "Pending" is derived, not stored: active with an active_at still in the
 * future. Nothing flips a row from held to usable, so there is no scheduled job
 * that can fail and leave somebody locked out of their own destination.
 *
 * Applied here on purpose rather than in each caller. This is the one function
 * `lib/engine/policy.js:169` consults, so narrowing it covers every send path at
 * once, including paths no interface currently reaches. Filtering a list would
 * not have done that.
 */
function usableOnly(query) {
  return query.eq('status', 'active').lte('active_at', new Date().toISOString());
}

/**
 * @param {string} accountId
 * @param {string} address
 */
async function isTrustedAddress(accountId, address) {
  if (!ethers.isAddress(address)) return false;
  const checksum = ethers.getAddress(address);
  const supabase = getSupabase();

  // limit(1) is load-bearing, not tidiness. Addresses are stored with the
  // casing the owner typed and uniqueness is on the exact string, so the same
  // address added twice in two casings is two rows. ilike then matches both,
  // and maybeSingle answers PGRST116 rather than a row, which threw out of here
  // and failed every send to a destination the owner had every reason to think
  // was fine. One match is all this question needs.
  const { data, error } = await usableOnly(
    supabase
      .from('trusted_addresses')
      .select('id')
      .eq('account_id', accountId)
      .ilike('address', checksum)
  )
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * How long a destination has left on its hold, or 0 if that is not why it was
 * refused.
 *
 * For the message only, never for the decision. `isTrustedAddress` above
 * decides, and it already said no by the time anything calls this. Kept apart
 * so a wrong answer here can only ever produce worse wording, not a send.
 *
 * @returns {Promise<number>} milliseconds remaining, 0 when not held
 */
async function trustedHoldRemainingMs(accountId, address) {
  if (!ethers.isAddress(address)) return 0;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('active_at')
    .eq('account_id', accountId)
    .ilike('address', ethers.getAddress(address))
    .eq('status', 'active')
    .gt('active_at', new Date().toISOString())
    .order('active_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return 0;
  const remaining = new Date(data.active_at).getTime() - Date.now();
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

/**
 * Destinations still inside their hold. The owner sees these in the cancel
 * prompt and in chat, and none of them can receive funds yet.
 */
async function listPendingTrusted(accountId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('id, address, label, active_at')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .gt('active_at', new Date().toISOString())
    .order('active_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Cancel a destination that is still held.
 *
 * Reachable from chat, which is the one authority-shaped action a weaker
 * channel may take, because it removes power rather than granting it. Scoped to
 * held rows: an active destination is deleted on the site behind the password,
 * since removing one someone relies on is damage an attacker would enjoy too.
 *
 * Marks cancelled rather than deleting, so the attempt stays on record.
 *
 * @returns {Promise<{ cancelled: number, rows: Array<{address: string, label: string}> }>}
 */
async function cancelPendingTrusted(accountId, addressOrLabel) {
  const supabase = getSupabase();
  const pending = await listPendingTrusted(accountId);
  if (!pending.length) return { cancelled: 0, rows: [] };

  const needle = String(addressOrLabel || '').trim().toLowerCase();
  const targets = needle
    ? pending.filter(
        (r) =>
          String(r.address || '').toLowerCase() === needle ||
          String(r.label || '').trim().toLowerCase() === needle
      )
    : pending;
  if (!targets.length) return { cancelled: 0, rows: [] };

  // The predicate is repeated on the write, not just the read above. Between
  // the two, a hold can expire, and cancelling a destination that has gone live
  // is the damage this function is scoped to avoid. Re-stating account_id keeps
  // the write scoped on its own terms rather than trusting the ids it was
  // handed.
  const { data: changed, error } = await supabase
    .from('trusted_addresses')
    .update({ status: 'cancelled' })
    .in('id', targets.map((r) => r.id))
    .eq('account_id', accountId)
    .eq('status', 'active')
    .gt('active_at', new Date().toISOString())
    .select('address, label');
  if (error) throw new Error(error.message);

  // Reported from what the write actually changed, not from what was aimed at.
  // The two differ exactly when a hold expired mid-call, and telling someone a
  // destination was cancelled when it was not is the worse of the two failures.
  const rows = changed || [];
  return {
    cancelled: rows.length,
    rows: rows.map((r) => ({ address: r.address, label: r.label })),
  };
}

/*
 * There is deliberately no addTrusted or removeTrusted in this module.
 *
 * This file is loaded by the bot. An earlier version carried both, with a
 * comment claiming they were "site-only mutation helpers (used by web API, not
 * WhatsApp)". That comment was false: lib/router.js imported addTrusted and
 * called it from two chat flows, and the comment is a large part of why the gap
 * survived review. A reader who believed it stopped looking.
 *
 * Granting a payout destination is a site act behind the account password. The
 * writers live in web/lib/trusted.ts and are reachable only from
 * web/app/api/trusted/route.ts and web/app/api/pay/save/route.ts, both of which
 * call requirePassword. Keeping a working writer here would leave a loaded
 * function for the next chat feature to import, which is exactly how this
 * happened the first time.
 *
 * Chat may still REMOVE authority: cancelPendingTrusted above is the one
 * mutation the bot can reach, and it only cancels destinations still inside
 * their hold.
 */

/**
 * Why the send was refused, and what to do about it.
 *
 * The rule itself stays in `config.rejectUntrustedCopy` so an operator can
 * reword it without a deploy. The route is appended here rather than baked into
 * that string, so a reworded rule cannot accidentally ship without one — the
 * old copy ended on "See site docs for details" and named no destination at
 * all, which is a dead end at the moment a send is refused.
 */
function rejectUntrustedMessage() {
  return [
    config.rejectUntrustedCopy,
    '',
    `Add them as trusted: ${config.siteUrl}/dashboard`,
    'Your password is needed to change the list.',
  ].join('\n');
}

/**
 * The same refusal, for a destination that is on the list but still held.
 *
 * Separate copy because the generic one tells them to go and add it, and they
 * did add it: that reads as the product having lost their work. This is also
 * the most common refusal in the first day of the hold existing, so it is worth
 * its own words rather than the catch-all.
 *
 * @param {number} remainingMs
 */
function trustedHoldMessage(remainingMs) {
  return [
    'That destination is still new.',
    '',
    `A payout destination cannot receive anything for its first 24 hours. This one has about ${formatWait(remainingMs)} left.`,
    'Nothing was sent.',
    '',
    'If you did not add it, reply: cancel wallet',
  ].join('\n');
}

module.exports = {
  listPendingTrusted,
  isTrustedAddress,
  trustedHoldRemainingMs,
  cancelPendingTrusted,
  rejectUntrustedMessage,
  trustedHoldMessage,
};
