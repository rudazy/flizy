/**
 * Claim holds from intent to settled (table claim_hold_attempts,
 * supabase/migrations/20261016130000_executor_reconcile.sql).
 *
 * A claim row is created only after the hold lands in escrow. A hold whose
 * outcome is unknown (broadcast, no receipt) would otherwise leave money in
 * escrow with no record of who it is for. So the hold's intent is written
 * before signing, its tx hash at broadcast, and the claim id once it lands:
 *
 *   sending -> submitted (hash) -> held (claim id)
 *   sending -> refused             executor refused before broadcasting
 *   submitted -> failed            receipt shows nothing moved
 *   submitted -> unknown           no receipt after an hour; admins told
 *   unknown -> held | failed       the receipt turned up after the hour
 *
 * Every status change is a compare-and-set on the status it expects, so the
 * send path and the reconciler can never both settle the same attempt.
 */

const { getSupabase } = require('./supabase');

const TABLE = 'claim_hold_attempts';

/**
 * Write the intent before anything is signed.
 * @returns {Promise<string>} attempt id
 */
async function openAttempt({ fromAccountId, chainId, amountEth, asset, tokenAddress, nftTokenId, claimArgs }) {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      from_account_id: fromAccountId,
      chain_id: chainId,
      status: 'sending',
      amount_eth: String(amountEth),
      asset,
      token_address: tokenAddress || null,
      nft_token_id: nftTokenId == null ? null : String(nftTokenId),
      claim_args: claimArgs || {},
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`claim hold attempt not recorded: ${error ? error.message : 'no row'}`);
  return data.id;
}

/** Compare-and-set one attempt from `from` to the patch. True when it moved. */
async function moveAttempt(id, from, patch) {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .eq('status', from)
    .select('id');
  if (error) throw new Error(`claim hold attempt ${id} not updated: ${error.message}`);
  return Boolean(data && data.length);
}

/** At broadcast. Throws when it cannot be written, so nothing is broadcast. */
async function markSubmitted(id, txHash) {
  const moved = await moveAttempt(id, 'sending', { status: 'submitted', hold_tx_hash: txHash });
  if (!moved) throw new Error(`claim hold attempt ${id} was not in 'sending'`);
}

/** @param {'submitted'|'unknown'} [from] */
async function markHeld(id, claimId, from = 'submitted') {
  return moveAttempt(id, from, { status: 'held', claim_id: claimId, error: null });
}

async function markRefused(id, reason) {
  return moveAttempt(id, 'sending', { status: 'refused', error: String(reason || 'refused').slice(0, 500) });
}

/** @param {'submitted'|'unknown'} [from] */
async function markFailed(id, reason, from = 'submitted') {
  return moveAttempt(id, from, { status: 'failed', error: String(reason || 'failed').slice(0, 500) });
}

async function markUnknown(id, from, reason) {
  return moveAttempt(id, from, { status: 'unknown', error: String(reason || 'unknown').slice(0, 500) });
}

module.exports = {
  openAttempt,
  markSubmitted,
  markHeld,
  markRefused,
  markFailed,
  markUnknown,
};
