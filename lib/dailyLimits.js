/**
 * Daily send volume for Policy Engine (UTC day).
 * Counts: confirmed/submitted transfers + pending claim holds created today.
 */

const { ethers } = require('ethers');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

function utcDayStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * @param {string} accountId
 * @returns {Promise<bigint>} wei spent today toward daily limit
 */
async function getDailySentWei(accountId) {
  const supabase = getSupabase();
  const since = utcDayStartIso();
  let total = 0n;

  const { data: transfers, error: tErr } = await supabase
    .from('transfers')
    .select('amount_eth, status')
    .eq('account_id', accountId)
    .gte('created_at', since)
    .in('status', ['pending', 'submitted', 'confirmed']);
  if (tErr) throw new Error(tErr.message);
  for (const row of transfers || []) {
    try {
      total += ethers.parseEther(String(row.amount_eth));
    } catch {
      /* skip */
    }
  }

  // 'processing' is a claim mid-payout or mid-refund. It still counts against
  // today's allowance: leaving it out would let a user slip an extra send in
  // during the window where a claim is in flight.
  const { data: claims, error: cErr } = await supabase
    .from('claims')
    .select('amount_eth, status')
    .eq('from_account_id', accountId)
    .gte('created_at', since)
    .in('status', ['pending', 'processing', 'claimed']);
  if (cErr) throw new Error(cErr.message);
  for (const row of claims || []) {
    try {
      total += ethers.parseEther(String(row.amount_eth));
    } catch {
      /* skip */
    }
  }

  return total;
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
        'Change limit on the site: Account → Daily limit',
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

module.exports = {
  utcDayStartIso,
  getDailySentWei,
  effectiveDailyLimitEth,
  checkDailySendLimit,
};
