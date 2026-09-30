/**
 * Daily ETH send limit for the Policy Engine (UTC day).
 *
 * What counts lives in one SQL function, daily_native_sent_eth
 * (supabase/migrations/20260930120000_daily_native_sent.sql): outgoing native
 * ETH transfers that are not swaps, plus native claim holds, including those
 * mid-payout or mid-refund. The site calls the same function through
 * web/lib/dailyLimits.ts, so chat and web cannot count differently.
 */

const { ethers } = require('ethers');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

/**
 * @param {string} accountId
 * @returns {Promise<bigint>} native wei sent today toward the daily limit
 */
async function getDailySentWei(accountId) {
  const { data, error } = await getSupabase().rpc('daily_native_sent_eth', {
    p_account_id: accountId,
  });
  if (error) throw new Error(error.message);
  return ethers.parseEther(String(data ?? '0'));
}

/**
 * Effective daily limit in ETH (number). null = no daily cap (only max per tx).
 * @param {{ daily_send_limit_eth?: number|string|null }} account
 * @param {number} [defaultLimit] from config; 0 or negative = no default cap
 */
function effectiveDailyLimitEth(account, defaultLimit = config.defaultDailySendLimitEth) {
  if (account && account.daily_send_limit_eth != null && account.daily_send_limit_eth !== '') {
    const n = Number(account.daily_send_limit_eth);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (defaultLimit != null && Number(defaultLimit) > 0) return Number(defaultLimit);
  return null;
}

/**
 * @param {string} accountId
 * @param {string|number} amountEth this send
 * @param {{ daily_send_limit_eth?: number|string|null }} account
 */
async function checkDailySendLimit(accountId, amountEth, account) {
  const limitEth = effectiveDailyLimitEth(account);
  if (limitEth == null) {
    return { ok: true, limitEth: null, spentEth: null, remainingEth: null };
  }

  const spentWei = await getDailySentWei(accountId);
  const amountWei = ethers.parseEther(String(amountEth));
  const limitWei = ethers.parseEther(String(limitEth));
  const next = spentWei + amountWei;

  if (next > limitWei) {
    const remaining = limitWei > spentWei ? limitWei - spentWei : 0n;
    return {
      ok: false,
      limitEth: String(limitEth),
      spentEth: ethers.formatEther(spentWei),
      remainingEth: ethers.formatEther(remaining),
      message: [
        'Daily send limit reached.',
        `Limit: ${limitEth} ETH / day (UTC)`,
        `Already sent today: ${ethers.formatEther(spentWei)} ETH`,
        `Remaining: ${ethers.formatEther(remaining)} ETH`,
        '',
        `Change limit on the site: ${config.siteUrl}/dashboard/account`,
      ].join('\n'),
    };
  }

  return {
    ok: true,
    limitEth: String(limitEth),
    spentEth: ethers.formatEther(spentWei),
    remainingEth: ethers.formatEther(limitWei - next),
  };
}

/**
 * The same check, reading the account's own limit. For callers that do not
 * already hold the account row, such as the re-check at confirm.
 * @param {string} accountId
 * @param {string|number} amountEth
 */
async function checkDailySendLimitNow(accountId, amountEth) {
  const { data, error } = await getSupabase()
    .from('accounts')
    .select('daily_send_limit_eth')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return checkDailySendLimit(accountId, amountEth, data || {});
}

module.exports = {
  getDailySentWei,
  effectiveDailyLimitEth,
  checkDailySendLimit,
  checkDailySendLimitNow,
};
