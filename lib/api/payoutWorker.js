/**
 * Flizy Pay API payouts, on the VPS.
 *
 * The site (web/app/api/v1/payouts) authenticates, validates and records a
 * payout as `accepted`; it never resolves the recipient and never moves money.
 * This worker takes one payout at a time (api_claim_payout) and runs it through
 * the same steps as a chat send (lib/router.js handleSendResolved and
 * handleConfirm): the account lock, send policy, the plan, the Savings fence,
 * funding checks, the daily limit under the lock, and the engine's executor.
 * What replaces the chat-only steps (session unlock and PIN, which prove a
 * person is present) is the API key with `payout`, the platform enabled, both
 * payout switches, Flizy's per-platform limits, and the platform's
 * passkey-signed allowance, which is the only way the money can move
 * (lib/api/allowanceSend.js).
 *
 * Every state change goes through api_transition, which writes the webhook
 * event in the same transaction. The transaction hash is stored on the payout
 * before the broadcast, so a payout taken again after a crash is one that was
 * never sent, and one with a hash is settled from its receipt instead.
 */

const { ethers } = require('ethers');
const { createSendIntent, evaluateSendPolicy, buildSendPlan, assertPlanFunded, executeNativeSend } = require('../engine');
const { ALLOWANCE_REASON } = require('../engine/executeTransfer');
const { resolveListedSendAsset } = require('../dex');
const { resolveFlizyPayDestination } = require('../payCode');
const { refusePlanSpend } = require('../reserves');
const { ensureAgentWallet } = require('../agentWallet');
const { planGasBufferEth } = require('../gatorExecute');
const { tryAccountTxLock, releaseAccountTxLock } = require('../accountTxLock');
const { checkDailySendLimitNow } = require('../dailyLimits');
const { displaySafeLabel } = require('../sanitize');
const { apiRelayerWallet, apiAllowanceSender, DECISION_CODES } = require('./allowanceSend');

const LEASE_SECONDS = 300;
const INTERVAL_MS = 5000;
/** Payouts taken per tick, one after another. */
const PER_TICK = 5;
/** A recorded hash older than this, still not settled, is checked against its receipt. */
const RECONCILE_AFTER_MS = 2 * 60 * 1000;

/** API asset name to engine symbol and decimals. */
const ASSETS = Object.freeze({
  ETH: { symbol: 'ETH', label: 'ETH', decimals: 18 },
  FLZ: { symbol: 'FLZ', label: 'FLZ', decimals: 18 },
  TUSD: { symbol: 'TUSD', label: 'tUSD', decimals: 6 },
});

/** "10.50" for 10.5, "20" for 20.0: formatUnits always keeps a decimal point. */
function plainAmount(units, decimals) {
  const s = ethers.formatUnits(units, decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** "Acme (Flizy partner) sent you 10 tUSD." The name is the one Flizy assigned, never platform text. */
function partnerLabel(displayName) {
  return `${displaySafeLabel(displayName, 60) || 'A Flizy partner'} (Flizy partner)`;
}
function formatPartnerNotice({ platformName, amount, label }) {
  return [`${partnerLabel(platformName)} sent you ${amount} ${label}.`, 'It is in your Flizy wallet: {{cmd:balance}}'].join('\n');
}

/** Both halves of the payout switch: API_PAYOUTS_ENABLED here and api_control in the database. */
async function payoutsSwitchedOn(supabase, env = process.env) {
  if (env.API_PAYOUTS_ENABLED !== 'true') return false;
  const { data, error } = await supabase.from('api_control').select('payouts_enabled').eq('id', true).maybeSingle();
  if (error || !data) return false;
  return data.payouts_enabled === true;
}

function makeWorker({ supabase, provider, chain, notifyAccount, requestPaymentNotice, env = process.env, log = console }) {
  const transition = async (id, to, detail = {}) => {
    const { error } = await supabase.rpc('api_transition', { p_transaction_id: id, p_to_state: to, p_detail: detail });
    if (error) throw new Error(`api_transition ${to}: ${error.message}`);
  };
  const update = async (id, fields) => {
    const { error } = await supabase.from('api_transactions').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(`api_transactions update: ${error.message}`);
  };
  const fail = async (row, code, extra = {}) => {
    await update(row.id, { error_code: code, lease_until: null, ...extra });
    await transition(row.id, 'failed', { error_code: code });
    log.warn(`[api-payout] ${row.id} failed: ${code}`);
    return 'failed';
  };
  /** Hand the payout back to the queue untouched: nothing was sent. */
  const later = async (row, why) => {
    await update(row.id, { lease_until: null });
    log.info(`[api-payout] ${row.id} waits: ${why}`);
    return 'later';
  };

  async function processPayout(row) {
    const asset = ASSETS[String(row.asset || '')];
    if (!asset || !/^[1-9][0-9]*$/.test(String(row.amount || ''))) return fail(row, 'invalid_request');
    const amount = BigInt(row.amount);

    const { data: platform, error: platErr } = await supabase
      .from('api_platforms')
      .select('id, account_id, display_name, wallet_address, enabled')
      .eq('id', row.platform_id)
      .maybeSingle();
    if (platErr) return later(row, 'platform unreadable');
    if (!platform || !platform.enabled) return fail(row, 'platform_disabled');

    // A key revoked, or its payout permission taken away, after the payout was
    // accepted: its queued payouts do not go out.
    const { data: key, error: keyErr } = await supabase.from('api_keys').select('revoked_at, scopes').eq('id', row.key_id).maybeSingle();
    if (keyErr) return later(row, 'key unreadable');
    if (!key || key.revoked_at || !(key.scopes || []).includes('payout')) return fail(row, 'key_revoked');

    if (!(await payoutsSwitchedOn(supabase, env))) return later(row, 'payouts are switched off');

    const { data: limits, error: limErr } = await supabase
      .from('api_platform_limits')
      .select('max_payout, daily_max')
      .eq('platform_id', platform.id)
      .eq('symbol', asset.symbol)
      .maybeSingle();
    if (limErr) return later(row, 'limits unreadable');
    if (!limits) return fail(row, 'asset_not_enabled');
    if (amount > BigInt(limits.max_payout)) return fail(row, 'over_max_payout');

    // The recipient is resolved here, after the site answered, so the answer
    // never says whether someone is on Flizy (Rule 3).
    let toAddress;
    let toLabel;
    if (row.recipient_kind === 'address') {
      if (!ethers.isAddress(String(row.recipient_ref || ''))) return fail(row, 'invalid_recipient');
      toAddress = ethers.getAddress(row.recipient_ref);
      if (toAddress === ethers.ZeroAddress) return fail(row, 'invalid_recipient');
      toLabel = `${toAddress.slice(0, 6)}...${toAddress.slice(-4)}`;
    } else if (row.recipient_kind === 'username') {
      const dest = await resolveFlizyPayDestination(supabase, String(row.recipient_ref || ''), platform.account_id);
      if (dest.self) return fail(row, 'recipient_is_platform');
      if (!dest.found || dest.noWallet || !dest.address) return fail(row, 'recipient_not_payable');
      toAddress = ethers.getAddress(dest.address);
      toLabel = dest.label;
    } else {
      return fail(row, 'invalid_recipient');
    }
    if (toAddress.toLowerCase() === String(platform.wallet_address).toLowerCase()) return fail(row, 'recipient_is_platform');

    const lock = await tryAccountTxLock(supabase, platform.account_id, 'api');
    if (!lock.ok) return later(row, 'another payment from this account is in progress');
    try {
      // The rolling day, counted under the lock so two payouts cannot both fit.
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: recent, error: recentErr } = await supabase
        .from('api_transactions')
        .select('id, amount, state')
        .eq('platform_id', platform.id)
        .eq('kind', 'payout')
        .eq('asset', String(row.asset))
        .gte('created_at', since);
      if (recentErr) return later(row, 'daily total unreadable');
      let spent = 0n;
      for (const r of recent || []) {
        if (r.id === row.id || !['queued', 'submitted', 'confirmed'].includes(r.state)) continue;
        if (/^[0-9]+$/.test(String(r.amount || ''))) spent += BigInt(r.amount);
      }
      if (spent + amount > BigInt(limits.daily_max)) return fail(row, 'over_daily_max');

      const { data: accountRow, error: accErr } = await supabase
        .from('accounts')
        .select('id, daily_send_limit_eth')
        .eq('id', platform.account_id)
        .maybeSingle();
      if (accErr || !accountRow) return later(row, 'account unreadable');

      const native = asset.symbol === 'ETH';
      const display = plainAmount(amount, asset.decimals);
      let tokenAddress = null;
      let tokenSymbol = null;
      if (!native) {
        const listed = resolveListedSendAsset(asset.symbol, chain.id);
        tokenAddress = listed.tokenAddress;
        tokenSymbol = listed.symbol;
      }

      const actor = { accountId: platform.account_id, waSenderId: 'api', channel: 'api', externalId: `platform:${platform.id}` };
      const intent = createSendIntent({
        actor,
        amountEth: display,
        toAddress,
        toLabel,
        toIsAddress: true,
        chainId: String(chain.chainId),
        asset: native ? 'native' : asset.symbol,
      });
      const policy = await evaluateSendPolicy(intent, {
        enforceTrusted: false,
        apiPayout: true,
        accountRow,
        nativeSymbol: chain.nativeSymbol || 'ETH',
      });
      if (policy.decision === 'DENY') return fail(row, 'policy_denied');

      const wallet = await ensureAgentWallet(platform.account_id);
      const fromAddress = ethers.getAddress(wallet.agent_wallet_address);
      if (fromAddress.toLowerCase() !== String(platform.wallet_address).toLowerCase()) return fail(row, 'wallet_mismatch');
      const fromBalanceEth = ethers.formatEther(await provider.getBalance(fromAddress));
      let tokenBalance = null;
      if (!native) {
        const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
        tokenBalance = ethers.formatUnits(await erc20.balanceOf(fromAddress), asset.decimals);
      }
      const plan = buildSendPlan({
        intent,
        policy,
        chain: { chainId: chain.chainId, chainName: chain.name, nativeSymbol: chain.nativeSymbol || 'ETH' },
        fromAddress,
        fromBalanceEth,
        tokenAddress,
        tokenSymbol,
        tokenBalance,
        reason: row.reference || null,
      });
      const gasBufferEth = await planGasBufferEth(provider, platform.account_id, fromAddress);
      const fenced = await refusePlanSpend(supabase, platform.account_id, plan, {
        ethBalanceHuman: fromBalanceEth,
        tokenBalanceHuman: tokenBalance,
        tokenDecimals: native ? null : asset.decimals,
        gasBufferEth,
      });
      if (!fenced.ok) return fail(row, 'insufficient_available_balance');
      if (!assertPlanFunded(plan, fromBalanceEth, gasBufferEth, { tokenBalance }).ok) return fail(row, 'insufficient_funds');

      if (native) {
        let daily;
        try {
          daily = await checkDailySendLimitNow(platform.account_id, display);
        } catch {
          return later(row, 'daily limit unreadable');
        }
        if (!daily.ok) return fail(row, 'account_daily_limit');
      }

      await update(row.id, { to_address: toAddress.toLowerCase() });
      const sender = apiAllowanceSender({
        platformId: platform.id,
        relayer: apiRelayerWallet(provider, env),
        // Stored before the broadcast: a payout with a hash is never taken again.
        onHash: async (hash) => {
          await update(row.id, { tx_hash: hash });
          await transition(row.id, 'submitted', { tx_hash: hash });
        },
        log,
      });
      const result = await executeNativeSend({
        plan,
        provider,
        chain,
        user: { id: null, balance_eth: 0 },
        supabase,
        permission: { send: sender.send, ownerKey: false },
      });
      if (result.transferId) await update(row.id, { transfer_id: result.transferId });

      if (result.ok) {
        await update(row.id, { lease_until: null, error_code: null });
        await transition(row.id, 'confirmed', { tx_hash: result.txHash });
        await notifyRecipient({ toAddress, platform, display, label: asset.label, txHash: result.txHash, platformAccountId: platform.account_id });
        return 'confirmed';
      }
      if (result.submitted) {
        // Mined and reverted (a hash came back): nothing moved. No hash: the
        // outcome is unknown and the receipt settles it later.
        if (result.txHash) return fail(row, 'reverted');
        await update(row.id, { lease_until: null });
        log.warn(`[api-payout] ${row.id} sent, outcome not known yet`);
        return 'submitted';
      }
      // Nothing reached the chain: a hash stored just before a broadcast that
      // never happened must not be shown as this payout's transaction.
      if (result.reason === ALLOWANCE_REASON) return fail(row, sender.decision.code || DECISION_CODES.noAllowance, { tx_hash: null });
      return fail(row, 'not_sent', { tx_hash: null });
    } finally {
      await releaseAccountTxLock(supabase, platform.account_id);
    }
  }

  async function notifyRecipient({ toAddress, platform, display, label, txHash, platformAccountId }) {
    try {
      const { data: payee } = await supabase.from('accounts').select('id').ilike('agent_wallet_address', toAddress.toLowerCase()).maybeSingle();
      if (!payee?.id || payee.id === platformAccountId) return;
      await notifyAccount(payee.id, formatPartnerNotice({ platformName: platform.display_name, amount: display, label }));
      await requestPaymentNotice(payee.id, { txHash, amount: display, asset: label, fromLabel: partnerLabel(platform.display_name), note: null });
    } catch (err) {
      // The money arrived; a failed notice must not read as a failed payout.
      log.warn(`[api-payout] recipient notice failed: ${String(err && err.message ? err.message : err).slice(0, 120)}`);
    }
  }

  /** Payouts with a hash that never settled: the receipt decides. */
  async function reconcile() {
    const before = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
    const { data: rows, error } = await supabase
      .from('api_transactions')
      .select('id, state, tx_hash')
      .eq('kind', 'payout')
      .in('state', ['queued', 'submitted'])
      .not('tx_hash', 'is', null)
      .lt('updated_at', before)
      .limit(10);
    if (error) throw new Error(error.message);
    for (const row of rows || []) {
      const receipt = await provider.getTransactionReceipt(row.tx_hash);
      if (!receipt) continue;
      if (row.state === 'queued') await transition(row.id, 'submitted', { tx_hash: row.tx_hash });
      if (receipt.status === 1) await transition(row.id, 'confirmed', { tx_hash: row.tx_hash });
      else {
        await update(row.id, { error_code: 'reverted' });
        await transition(row.id, 'failed', { error_code: 'reverted' });
      }
      await update(row.id, { lease_until: null });
    }
  }

  /** One pass: settle what was sent, then take up to PER_TICK payouts in order. Never throws. */
  async function tick() {
    try {
      await reconcile();
    } catch (err) {
      log.warn(`[api-payout] reconcile: ${String(err && err.message ? err.message : err).slice(0, 160)}`);
    }
    if (!(await payoutsSwitchedOn(supabase, env).catch(() => false))) return 0;
    let done = 0;
    for (let i = 0; i < PER_TICK; i += 1) {
      const { data, error } = await supabase.rpc('api_claim_payout', { p_lease_seconds: LEASE_SECONDS });
      if (error) {
        log.warn(`[api-payout] claim: ${error.message}`);
        break;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) break;
      try {
        const outcome = await processPayout(row);
        if (outcome === 'later') break;
        done += 1;
      } catch (err) {
        // Unexpected: the lease runs out and, with no hash recorded, the
        // payout is taken again; with a hash, the receipt settles it.
        log.error(`[api-payout] ${row.id}: ${String(err && err.message ? err.message : err).slice(0, 200)}`);
        break;
      }
    }
    return done;
  }

  return { tick, processPayout, reconcile };
}

/** Started from the WhatsApp process only, like the approval worker. */
function startApiPayoutWorker(deps) {
  const worker = makeWorker(deps);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await worker.tick();
    } finally {
      running = false;
    }
  }, deps.intervalMs || INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { makeWorker, startApiPayoutWorker, plainAmount, ASSETS };
