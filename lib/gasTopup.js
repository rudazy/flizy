/**
 * Gas paid for wallets through their EntryPoint deposit.
 *
 * A HybridDeleGator's UserOp prefund comes out of its EntryPoint deposit
 * before its own ETH (lib/gatorExecute.js). With GAS_TOPUP_ENABLED, a
 * dedicated top-up key pays EntryPoint.depositTo(wallet) for the shortfall
 * just before the wallet's UserOp, so the wallet needs no ETH for gas.
 *
 * - Switch: GAS_TOPUP_ENABLED, off unless exactly "true". On needs
 *   GAS_TOPUP_PRIVATE_KEY, a key of its own: never PRIVATE_KEY, which submits
 *   every UserOp and would race these for nonces. One top-up in flight per key,
 *   across processes, through the relayer lease (lib/custody/relayerLock.js).
 * - Cap: GAS_TOPUP_WALLET_DAILY_CAP_USD per wallet over 24 hours, priced at
 *   FEE_ETH_USD_RATE. A row in gas_topups is written before each top-up is
 *   sent, so a second send counts it. Over the cap, nothing is topped up and
 *   the wallet pays its own gas, as before.
 * - Daily cap: GAS_TOPUP_DAILY_CAP_USD across every wallet over 24 hours ($10
 *   by default), so many wallets together cannot drain the key. Reached, no
 *   wallet is topped up until the window moves, and the admins are told once
 *   a day per process. Both caps are checked again once the pending row is
 *   written, so two top-ups racing past a cap are never both sent: one or both
 *   is refused.
 * - A top-up that cannot be made (switch off, cap reached, key out of ETH, the
 *   lease busy, a refused or reverted transaction) is never an error for the
 *   payment: the wallet's own ETH covers the gas, or the send refuses for want
 *   of it, exactly as without this module.
 *
 * Testnet stopgap: a deposit can be withdrawn by the wallet's owner, so this is
 * replaced with a paymaster before ownership moves to users.
 *
 * Mirror: web/lib/gasTopup.ts. test/gasTopup.test.js runs both.
 */

const { ethers } = require('ethers');
const { parseUsdMicro, DEFAULTS: FEE_DEFAULTS } = require('./fees');
const { withRelayerLock } = require('./custody/relayerLock');
const { publicErrorMessage } = require('./sanitize');

const TABLE = 'gas_topups';
const DAY_MS = 24 * 3600 * 1000;
/** Top up a quarter above the shortfall, for fee movement before the UserOp lands. Unused deposit stays for the next one. */
const TOPUP_MARGIN_BPS = 12_500n;
/** Gas the depositTo transaction itself is given. */
const DEPOSIT_GAS_LIMIT = 80_000n;
const RECEIPT_TIMEOUT_MS = 60_000;
const DEFAULT_WALLET_DAILY_CAP_USD = '0.5';
const DEFAULT_DAILY_CAP_USD = '10';
/** Rows read per page when totalling today's top-ups, and the most pages read before refusing. */
const COUNT_PAGE = 1000;
const COUNT_MAX_PAGES = 50;

const EP_IFACE = new ethers.Interface(['function depositTo(address account) payable', 'function balanceOf(address account) view returns (uint256)']);

/**
 * The top-up settings. On without a key, or a malformed cap or key, throws.
 * @param {Record<string, string|undefined>} [env]
 */
function topupConfig(env = process.env) {
  const enabled = String(env.GAS_TOPUP_ENABLED || '').trim().toLowerCase() === 'true';
  const rawKey = String(env.GAS_TOPUP_PRIVATE_KEY || '').trim();
  let address = null;
  if (rawKey) {
    try {
      address = new ethers.Wallet(rawKey).address;
    } catch {
      throw new Error('GAS_TOPUP_PRIVATE_KEY is not a private key');
    }
    if (rawKey.toLowerCase() === String(env.PRIVATE_KEY || '').trim().toLowerCase()) {
      throw new Error('GAS_TOPUP_PRIVATE_KEY must not be PRIVATE_KEY');
    }
  }
  if (enabled && !address) throw new Error('GAS_TOPUP_ENABLED needs GAS_TOPUP_PRIVATE_KEY');
  const capRaw = String(env.GAS_TOPUP_WALLET_DAILY_CAP_USD || '').trim() || DEFAULT_WALLET_DAILY_CAP_USD;
  const dailyRaw = String(env.GAS_TOPUP_DAILY_CAP_USD || '').trim() || DEFAULT_DAILY_CAP_USD;
  const rateRaw = String(env.FEE_ETH_USD_RATE || '').trim() || FEE_DEFAULTS.FEE_ETH_USD_RATE;
  const ethUsd = parseUsdMicro(rateRaw, 'FEE_ETH_USD_RATE');
  if (ethUsd === 0n) throw new Error('FEE_ETH_USD_RATE must be above zero');
  return Object.freeze({
    enabled,
    address,
    walletDailyCap: parseUsdMicro(capRaw, 'GAS_TOPUP_WALLET_DAILY_CAP_USD'),
    dailyCap: parseUsdMicro(dailyRaw, 'GAS_TOPUP_DAILY_CAP_USD'),
    ethUsd,
  });
}

/** The amount to deposit for a shortfall: a quarter more, so the UserOp still fits if fees move. */
function topupAmountWei(shortfallWei) {
  return (BigInt(shortfallWei) * TOPUP_MARGIN_BPS + 9_999n) / 10_000n;
}

function weiToUsdMicro(wei, ethUsd) {
  return (BigInt(wei) * BigInt(ethUsd) + 10n ** 18n - 1n) / 10n ** 18n;
}

/** micro-USD topped up for this wallet in the last 24 hours, pending or sent. Throws when it cannot be read. */
async function toppedUpToday(supabase, wallet, now = Date.now()) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('usd_micro')
    .eq('wallet', String(wallet).toLowerCase())
    .in('status', ['pending', 'sent'])
    .gte('created_at', new Date(now - DAY_MS).toISOString());
  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, r) => sum + BigInt(r.usd_micro), 0n);
}

/**
 * micro-USD topped up for every wallet in the last 24 hours, pending or sent,
 * read in pages. Throws when it cannot be read, or when there are too many
 * rows to count: the caller then tops up nothing.
 */
async function toppedUpTotalToday(supabase, now = Date.now()) {
  let sum = 0n;
  for (let page = 0; page < COUNT_MAX_PAGES; page += 1) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('usd_micro')
      .in('status', ['pending', 'sent'])
      .gte('created_at', new Date(now - DAY_MS).toISOString())
      .order('id', { ascending: true })
      .range(page * COUNT_PAGE, (page + 1) * COUNT_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    sum += rows.reduce((total, r) => total + BigInt(r.usd_micro), 0n);
    if (rows.length < COUNT_PAGE) return sum;
  }
  throw new Error('too many top-ups today to count');
}

/** The UTC day the admins were last told the daily cap was reached, in this process. */
let capAlertDay = null;

/** Tell the admins (lib/commands/chat.js adminAccountIds) and Sentry. Never throws. */
async function defaultCapAlert(supabase, text) {
  try {
    require('./sentry').reportError(new Error(`[gas-topup] ${text}`));
  } catch {
    /* Sentry is optional */
  }
  try {
    const { adminAccountIds } = require('./commands/chat');
    const { notifyAccount } = require('./notify');
    for (const id of await adminAccountIds(supabase)) {
      await notifyAccount(id, `Flizy gas top-up: ${text}`);
    }
  } catch (err) {
    console.error('[gas-topup] admin notice failed:', publicErrorMessage(err));
  }
}

/** The daily cap was reached: the admins are told once per UTC day, per process. Never throws. */
async function alertDailyCap({ supabase, cfg, alert, log, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (capAlertDay === day) return;
  capAlertDay = day;
  const text = `the daily cap of $${(Number(cfg.dailyCap) / 1e6).toFixed(2)} across all wallets is reached, so no wallet is topped up until it frees. Wallets pay their own gas meanwhile.`;
  log.warn(`[gas-topup] ${text}`);
  try {
    await (alert || ((t) => defaultCapAlert(supabase, t)))(text);
  } catch (err) {
    log.warn(`[gas-topup] cap alert failed: ${publicErrorMessage(err)}`);
  }
}

/**
 * Whether a top-up would cover this shortfall right now: switch on, key set,
 * and room left under the wallet's cap and the daily cap. Reads only; never
 * throws (false on any failure, so the caller asks the wallet for its own gas,
 * as before).
 */
async function topupWouldCover({ supabase, wallet, shortfallWei, env = process.env }) {
  try {
    const cfg = topupConfig(env);
    if (!cfg.enabled || BigInt(shortfallWei) <= 0n) return false;
    const usd = weiToUsdMicro(topupAmountWei(shortfallWei), cfg.ethUsd);
    if ((await toppedUpToday(supabase, wallet)) + usd > cfg.walletDailyCap) return false;
    return (await toppedUpTotalToday(supabase)) + usd <= cfg.dailyCap;
  } catch {
    return false;
  }
}

/**
 * Pay EntryPoint.depositTo(wallet) for a shortfall, within the cap.
 * @returns {Promise<{ ok: true, amountWei: bigint, txHash: string, blockNumber: number } | { ok: false, reason: string }>}
 *   ok only once the deposit is mined. Never throws.
 */
async function topUpGasDeposit({ supabase, provider, entryPoint, wallet, accountId = null, shortfallWei, env = process.env, log = console, signer, alert }) {
  let cfg;
  try {
    cfg = topupConfig(env);
  } catch (err) {
    log.warn(`[gas-topup] settings: ${publicErrorMessage(err)}`);
    return { ok: false, reason: 'settings' };
  }
  if (!cfg.enabled) return { ok: false, reason: 'off' };
  const shortfall = BigInt(shortfallWei);
  if (shortfall <= 0n) return { ok: false, reason: 'none needed' };
  const amountWei = topupAmountWei(shortfall);
  const usdMicro = weiToUsdMicro(amountWei, cfg.ethUsd);
  const walletLower = ethers.getAddress(wallet).toLowerCase();
  const fail = async (rowId, reason) => {
    log.warn(`[gas-topup] not topped up: ${reason}`);
    if (rowId) {
      const { error } = await supabase.from(TABLE).update({ status: 'failed', reason: reason.slice(0, 200) }).eq('id', rowId);
      if (error) log.warn(`[gas-topup] could not mark the row failed: ${error.message}`);
    }
    return { ok: false, reason };
  };

  let spent;
  try {
    spent = await toppedUpToday(supabase, walletLower);
  } catch (err) {
    return fail(null, `could not read today's top-ups (${publicErrorMessage(err)})`);
  }
  if (spent + usdMicro > cfg.walletDailyCap) return fail(null, 'daily cap reached');
  let total;
  try {
    total = await toppedUpTotalToday(supabase);
  } catch (err) {
    return fail(null, `could not read today's total (${publicErrorMessage(err)})`);
  }
  if (total + usdMicro > cfg.dailyCap) {
    await alertDailyCap({ supabase, cfg, alert, log });
    return fail(null, 'daily cap across all wallets reached');
  }

  // Tests hand in a recording signer; live, it is always the top-up key.
  const key = signer || new ethers.Wallet(String(env.GAS_TOPUP_PRIVATE_KEY).trim(), provider);
  const data = EP_IFACE.encodeFunctionData('depositTo', [ethers.getAddress(wallet)]);
  let fee;
  try {
    fee = await provider.getFeeData();
    const maxFee = fee.maxFeePerGas || fee.gasPrice || 0n;
    if ((await provider.getBalance(key.address)) < amountWei + DEPOSIT_GAS_LIMIT * maxFee) return fail(null, 'the top-up key is out of ETH');
  } catch (err) {
    return fail(null, `could not read the top-up key (${publicErrorMessage(err)})`);
  }

  const { data: row, error: insErr } = await supabase
    .from(TABLE)
    .insert({ wallet: walletLower, account_id: accountId, amount_wei: amountWei.toString(), usd_micro: usdMicro.toString(), status: 'pending' })
    .select('id')
    .maybeSingle();
  if (insErr || !row || !row.id) return fail(null, `could not record the top-up (${insErr ? insErr.message : 'no row'})`);
  // Counted again with this row in: a top-up written in between is seen, and
  // over either cap this one is not sent.
  try {
    if ((await toppedUpToday(supabase, walletLower)) > cfg.walletDailyCap) return fail(row.id, 'daily cap reached');
    if ((await toppedUpTotalToday(supabase)) > cfg.dailyCap) {
      await alertDailyCap({ supabase, cfg, alert, log });
      return fail(row.id, 'daily cap across all wallets reached');
    }
  } catch (err) {
    return fail(row.id, `could not read today's top-ups (${publicErrorMessage(err)})`);
  }

  // Required here, not at the top: lib/gatorExecute.js loads this module.
  const { classifyBroadcastError } = require('./gatorExecute');
  let sent;
  try {
    sent = await withRelayerLock({ supabase, relayer: key.address }, async () => {
      const populated = await key.populateTransaction({ to: entryPoint, data, value: amountWei, gasLimit: DEPOSIT_GAS_LIMIT });
      const signed = await key.signTransaction(populated);
      const hash = ethers.keccak256(signed);
      try {
        await provider.broadcastTransaction(signed);
        return { hash, kind: 'accepted' };
      } catch (err) {
        return { hash, kind: classifyBroadcastError(err), err };
      }
    });
  } catch (err) {
    return fail(row.id, `not sent (${publicErrorMessage(err)})`);
  }
  if (sent.kind === 'rejected') return fail(row.id, `refused by the node (${publicErrorMessage(sent.err)})`);
  const txHash = sent.hash;
  // Accepted, or no answer: it may land, so it is 'sent' and counts against the cap either way.
  const { error: sentErr } = await supabase.from(TABLE).update({ status: 'sent', tx_hash: txHash }).eq('id', row.id);
  if (sentErr) log.warn(`[gas-topup] could not record the hash: ${sentErr.message}`);
  if (sent.kind === 'unknown') return { ok: false, reason: 'no answer from the node' };

  let receipt = null;
  try {
    receipt = await provider.waitForTransaction(txHash, 1, RECEIPT_TIMEOUT_MS);
  } catch {
    receipt = null;
  }
  // No receipt yet: it stays 'sent' and counts against the cap; this UserOp
  // falls back to the wallet's own ETH.
  if (!receipt) return { ok: false, reason: 'not mined yet' };
  if (receipt.status !== 1) return fail(row.id, 'the deposit reverted');
  log.info(`[gas-topup] deposit for a wallet, ${ethers.formatEther(amountWei)} ETH`);
  return { ok: true, amountWei, txHash, blockNumber: receipt.blockNumber };
}

/** Tests only: forget that the admins were told today. */
function resetCapAlert() {
  capAlertDay = null;
}

module.exports = {
  topupConfig,
  topupAmountWei,
  weiToUsdMicro,
  toppedUpToday,
  toppedUpTotalToday,
  topupWouldCover,
  topUpGasDeposit,
  resetCapAlert,
  TOPUP_MARGIN_BPS,
};
