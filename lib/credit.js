/**
 * Internal credit ledger moves that must be atomic.
 *
 * A send used to read balance_eth, go to the chain, then write back an absolute
 * value worked out from the stale read. Two sends across two channels both read
 * the same starting balance and the second overwrote the first, so one debit
 * disappeared. These helpers push the read, the guard and the write into a
 * single statement in Postgres (see the debit_user_balance migration) so
 * concurrent debits queue on the row lock instead of clobbering each other.
 *
 * Absolute sets (the admin credit command) do NOT belong here. Setting a
 * balance to a chosen value is a different operation with different rules.
 */

const { getSupabase } = require('./supabase');

/**
 * Reserve credit for a send. Guarded: fails rather than going negative.
 *
 * @param {string} userId
 * @param {string|number} amountEth
 * @returns {Promise<{ ok: boolean, balanceEth: number }>}
 *   ok=false means the balance could not cover it. balanceEth is the balance
 *   after a successful debit, or the untouched current balance on failure.
 */
async function debitUserCredit(userId, amountEth) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('debit_user_balance', {
    p_user_id: userId,
    p_amount: String(amountEth),
  });
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: Boolean(row && row.success),
    balanceEth: Number(row && row.new_balance != null ? row.new_balance : 0),
  };
}

/**
 * Return a reservation after a send that never reached the chain.
 *
 * @param {string} userId
 * @param {string|number} amountEth
 * @returns {Promise<{ ok: boolean, balanceEth: number }>}
 */
async function creditUserCredit(userId, amountEth) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('credit_user_balance', {
    p_user_id: userId,
    p_amount: String(amountEth),
  });
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: Boolean(row && row.success),
    balanceEth: Number(row && row.new_balance != null ? row.new_balance : 0),
  };
}

module.exports = {
  debitUserCredit,
  creditUserCredit,
};
