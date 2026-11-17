/**
 * Rewards: what each account earns from the fees Flizy charged.
 *
 * Every charged fee in the ledger (fee_ledger) settled after REWARDS_START_AT
 * is worked out once, on this process only, and its rewards are recorded with
 * record_fee_rewards (migration 20261117120000_rewards.sql), which marks the
 * fee done in the same statement:
 *
 *   p2p, swap   cashback to the account that paid the fee, and a referral
 *               reward to the account that invited it
 *   merchant    a business reward to the business whose sale carried the fee,
 *               and a referral reward to the account that invited the business
 *   api_payout  nothing
 *
 * Each reward is a share of the fee net of the gas Flizy paid for it (the
 * gross fee when that gas is not known). A referral counts only for fees
 * settled after the invite was counted (lib/invite.js), so the result does
 * not depend on when this runs.
 *
 * The shares are server settings only (REWARDS_CASHBACK_BPS,
 * REWARDS_REFERRAL_BPS, REWARDS_MERCHANT_BPS): they have no defaults in code
 * and are never shown to users. Off unless REWARDS_ENABLED is true; then every
 * share and REWARDS_START_AT are required, and a malformed one throws at start.
 */

const { publicErrorMessage } = require('./sanitize');

const TICK_MS = 60_000;
const BATCH = 100;

function parseBps(raw, name) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number`);
  const n = Number(text);
  if (n > 10000) throw new Error(`${name} must be between 0 and 10000`);
  return n;
}

/**
 * The rewards settings, read from the environment.
 * @param {Record<string, string|undefined>} [env]
 */
function rewardsConfig(env = process.env) {
  const enabled = String(env.REWARDS_ENABLED || '').trim().toLowerCase() === 'true';
  // A share that is not set is 0 while rewards are off, and required once on.
  const bps = (key) => {
    const v = String(env[key] ?? '').trim();
    if (!v) {
      if (enabled) throw new Error(`REWARDS_ENABLED needs ${key}`);
      return 0;
    }
    return parseBps(v, key);
  };
  const cashbackBps = bps('REWARDS_CASHBACK_BPS');
  const referralBps = bps('REWARDS_REFERRAL_BPS');
  const merchantBps = bps('REWARDS_MERCHANT_BPS');
  // A fee can never pay out more than itself.
  if (cashbackBps + referralBps > 10000 || merchantBps + referralBps > 10000) {
    throw new Error('rewards on a fee add up to more than the fee');
  }
  const rawStart = String(env.REWARDS_START_AT || '').trim();
  let startAt = null;
  if (rawStart) {
    const t = Date.parse(rawStart);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(rawStart) || Number.isNaN(t)) throw new Error('REWARDS_START_AT must be an ISO date and time');
    startAt = new Date(t).toISOString();
  }
  if (enabled && !startAt) throw new Error('REWARDS_ENABLED needs REWARDS_START_AT');
  return Object.freeze({ enabled, startAt, cashbackBps, referralBps, merchantBps });
}

/** The amount a fee's rewards are shares of: the fee net of gas, or the gross fee when gas is not known. Never negative. */
function rewardBase(fee) {
  const raw = fee.net_usd_micro == null ? fee.fee_usd_micro : fee.net_usd_micro;
  const base = BigInt(raw ?? 0);
  return base > 0n ? base : 0n;
}

const share = (base, bps) => (base * BigInt(bps)) / 10000n;

/**
 * The reward entries for one fee. Pure: the business (for a merchant fee) and
 * the earner's counted inviter are looked up by the caller.
 * @param {{ kind: string, account_id: string|null, fee_usd_micro: string|number, net_usd_micro: string|number|null }} fee
 * @param {{ business?: string|null, inviter?: string|null }} who
 * @param {ReturnType<typeof rewardsConfig>} cfg
 * @returns {Array<{ account_id: string, kind: 'cashback'|'referral'|'merchant', usd_micro: string, from_account_id: string|null }>}
 */
function planFeeRewards(fee, who, cfg) {
  const base = rewardBase(fee);
  let earner = null;
  let own = null;
  if (fee.kind === 'p2p' || fee.kind === 'swap') {
    earner = fee.account_id || null;
    own = { kind: 'cashback', amount: share(base, cfg.cashbackBps) };
  } else if (fee.kind === 'merchant') {
    earner = who.business || null;
    own = { kind: 'merchant', amount: share(base, cfg.merchantBps) };
  }
  if (!earner || base === 0n) return [];
  const out = [];
  if (own.amount > 0n) out.push({ account_id: earner, kind: own.kind, usd_micro: own.amount.toString(), from_account_id: null });
  const inviter = who.inviter || null;
  const referral = share(base, cfg.referralBps);
  if (inviter && inviter !== earner && referral > 0n) {
    out.push({ account_id: inviter, kind: 'referral', usd_micro: referral.toString(), from_account_id: earner });
  }
  return out;
}

/** Charged fees whose rewards are not recorded yet, oldest first. Throws on a read error. */
async function dueFees(supabase, cfg, limit) {
  const { data, error } = await supabase
    .from('fee_ledger')
    .select('id, kind, account_id, source_kind, source_id, fee_usd_micro, net_usd_micro, settled_at')
    .eq('state', 'charged')
    .is('rewards_at', null)
    .gte('settled_at', cfg.startAt)
    .order('settled_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * The business behind each merchant fee: the account whose wallet the payment
 * went to, never the payer. Throws on a read error, so no fee is recorded
 * without its business.
 * @returns {Promise<Map<string, string>>} fee id -> business account id
 */
async function businessesOf(supabase, fees) {
  const out = new Map();
  const merchant = fees.filter((f) => f.kind === 'merchant' && f.source_kind === 'transfer');
  if (!merchant.length) return out;
  const { data: transfers, error } = await supabase
    .from('transfers')
    .select('id, to_address')
    .in('id', merchant.map((f) => String(f.source_id)));
  if (error) throw new Error(error.message);
  const toOf = new Map((transfers || []).map((t) => [String(t.id), String(t.to_address || '').toLowerCase()]));
  const byWallet = new Map();
  for (const fee of merchant) {
    const wallet = toOf.get(String(fee.source_id));
    if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) continue;
    if (!byWallet.has(wallet)) {
      const { data: acct, error: acctErr } = await supabase.from('accounts').select('id').ilike('agent_wallet_address', wallet).maybeSingle();
      if (acctErr) throw new Error(acctErr.message);
      byWallet.set(wallet, acct ? String(acct.id) : null);
    }
    const business = byWallet.get(wallet);
    if (business && business !== fee.account_id) out.set(String(fee.id), business);
  }
  return out;
}

/**
 * Who invited each earner, with when the invite was counted. Throws on a read
 * error, so no fee is recorded without its referral.
 * @returns {Promise<Map<string, { inviter: string, countedAt: string }>>}
 */
async function countedInviters(supabase, earners) {
  const out = new Map();
  if (!earners.length) return out;
  const { data, error } = await supabase
    .from('invite_attributions')
    .select('invitee_account_id, inviter_account_id, counted_at')
    .in('invitee_account_id', earners);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    if (row.counted_at) out.set(String(row.invitee_account_id), { inviter: String(row.inviter_account_id), countedAt: row.counted_at });
  }
  return out;
}

/**
 * One batch: the rewards for up to `limit` due fees. A fee whose record fails
 * is left for the next run.
 * @param {{ supabase: object, cfg: ReturnType<typeof rewardsConfig>, limit?: number, log?: Pick<Console, 'error'> }} deps
 */
async function accrueRewards({ supabase, cfg, limit = BATCH, log = console }) {
  const counts = { recorded: 0, skipped: 0, failed: 0 };
  const fees = await dueFees(supabase, cfg, limit);
  if (!fees.length) return counts;
  const businesses = await businessesOf(supabase, fees);
  const earnerOf = (fee) => (fee.kind === 'merchant' ? businesses.get(String(fee.id)) : fee.account_id) || null;
  const earners = [...new Set(fees.map(earnerOf).filter(Boolean).map(String))];
  const inviters = await countedInviters(supabase, earners);

  for (const fee of fees) {
    const earner = earnerOf(fee);
    const invite = earner ? inviters.get(String(earner)) : null;
    // Only fees settled once the invite had been counted.
    const inviter = invite && Date.parse(invite.countedAt) <= Date.parse(fee.settled_at) ? invite.inviter : null;
    const entries = planFeeRewards(fee, { business: businesses.get(String(fee.id)) || null, inviter }, cfg);
    try {
      const { data, error } = await supabase.rpc('record_fee_rewards', { p_fee_id: fee.id, p_entries: entries });
      if (error) throw new Error(error.message);
      if (data === true) counts.recorded += 1;
      else counts.skipped += 1;
    } catch (err) {
      counts.failed += 1;
      log.error(`[rewards] fee ${fee.id}:`, publicErrorMessage(err));
    }
  }
  return counts;
}

/**
 * Run on a timer, one batch at a time. Returns null, and runs nothing, while
 * rewards are off. Throws at start on a malformed setting.
 * @param {{ supabase: object, env?: Record<string, string|undefined> }} deps
 */
function startRewardsWorker({ supabase, env = process.env }) {
  const cfg = rewardsConfig(env);
  if (!cfg.enabled) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await accrueRewards({ supabase, cfg });
      if (counts.recorded || counts.failed) console.log('[rewards]', counts);
    } catch (err) {
      console.error('[rewards] tick:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  rewardsConfig,
  rewardBase,
  planFeeRewards,
  accrueRewards,
  startRewardsWorker,
};
