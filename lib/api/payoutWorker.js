/**
 * Flizy Pay API payouts, on the VPS.
 *
 * The site (web/app/api/v1/payouts) authenticates, validates and records a
 * payout as `accepted`; it never resolves the recipient and never moves money.
 * This worker takes one payout at a time (api_claim_payout) and runs it through
 * the same steps as a chat send (lib/router.js handleSendResolved and
 * handleConfirm, lib/handlers/claims.js openClaimHold): the account lock, send
 * or claim-hold policy, the plan, the Savings fence, funding checks, the daily
 * limit under the lock, and the engine's executor. What replaces the
 * chat-only steps (session unlock and PIN, which prove a person is present) is
 * the API key with `payout`, the platform enabled, both payout switches,
 * Flizy's per-platform limits, and the platform's passkey-signed allowance,
 * which is the only way the money can move (lib/api/allowanceSend.js).
 *
 * A username or an address is paid directly. A phone, an email or a Telegram,
 * Discord or GitHub id always becomes an escrow claim, whether or not that
 * person is on Flizy, so nothing the platform sees says who is a member. The
 * claim carries an expiry; past it, or when the platform cancels, the worker
 * refunds it from escrow to the platform's wallet, and a refund counts only
 * once its transaction is confirmed. A claim the platform's owner cancels in
 * chat is recorded the same way.
 *
 * Every state change goes through api_transition, which writes the webhook
 * event in the same transaction. Every transaction hash (payout, hold, refund)
 * is stored before its broadcast, so work taken again after a crash is work
 * that was never sent, and anything with a hash is settled from its receipt.
 */

const { ethers } = require('ethers');
const {
  createSendIntent,
  evaluateSendPolicy,
  evaluateClaimHoldPolicy,
  buildSendPlan,
  buildClaimPlan,
  assertPlanFunded,
  executeNativeSend,
  executeClaimHold,
  executeClaimRefund,
} = require('../engine');
const { ALLOWANCE_REASON } = require('../engine/allowance');
const { config } = require('../config');
const { resolveListedSendAsset } = require('../dex');
const { resolveFlizyPayDestination } = require('../payCode');
const { refusePlanSpend } = require('../reserves');
const { ensureAgentWallet } = require('../agentWallet');
const { planGasBufferEth } = require('../gatorExecute');
const { tryAccountTxLock, releaseAccountTxLock } = require('../accountTxLock');
const { checkDailySendLimitNow } = require('../dailyLimits');
const { displaySafeLabel } = require('../sanitize');
const { phoneRecipient, emailRecipient, platformRecipient, claimRecipientLabel } = require('../claimRecipient');
const { beginClaimProcessing, cancelClaim, getClaimById } = require('../claims');
const { findAccountIdByPhone, getAccountByIdentity } = require('../identity');
const { findAccountIdByEmail } = require('../accountEmails');
const { apiRelayerWallet, apiAllowanceSender, DECISION_CODES } = require('./allowanceSend');

const LEASE_SECONDS = 300;
const INTERVAL_MS = 5000;
/** Payouts taken per tick, one after another. */
const PER_TICK = 5;
/** API claims looked at per tick. */
const CLAIMS_PER_TICK = 20;
/** A recorded hash older than this, still not settled, is checked against its receipt. */
const RECONCILE_AFTER_MS = 2 * 60 * 1000;
/** An API claim is looked at again no sooner than this, so every one gets its turn. */
const CLAIM_RECHECK_MS = 30 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** API asset name to engine symbol and decimals. */
const ASSETS = Object.freeze({
  ETH: { symbol: 'ETH', label: 'ETH', decimals: 18 },
  FLZ: { symbol: 'FLZ', label: 'FLZ', decimals: 18 },
  TUSD: { symbol: 'TUSD', label: 'tUSD', decimals: 6 },
});

/** Recipient types paid as a claim, and the chat channel each platform id belongs to. */
const CLAIM_KINDS = Object.freeze(['phone', 'email', 'telegram', 'discord', 'github']);
const PLATFORM_CHANNELS = Object.freeze({ telegram: 'telegram', discord: 'discord', github: 'github' });

/** States whose amount counts against the rolling day: everything that may have moved money. */
const COUNTED_STATES = Object.freeze(['queued', 'submitted', 'confirmed', 'claim_pending', 'expired', 'refund_pending', 'refunded']);

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
function formatPartnerClaimNotice({ platformName, amount, label, expiresAt }) {
  const until = new Date(expiresAt).toUTCString().replace(/ GMT$/, ' UTC');
  return [
    'Pending claim on Flizy',
    '',
    `Amount: ${amount} ${label}`,
    `From:   ${partnerLabel(platformName)}`,
    '',
    'Receive it: {{cmd:claim}} (chat) or Claim on the site',
    `It stays held for you until ${until}. The sender can cancel until then.`,
  ].join('\n');
}

/** The claim recipient a payout names. Platform ids must be the numeric user id, never a handle. */
function claimRecipientFor(kind, ref) {
  if (kind === 'phone') return phoneRecipient(ref);
  if (kind === 'email') return emailRecipient(ref);
  const channel = PLATFORM_CHANNELS[kind];
  if (channel && /^[0-9]{1,30}$/.test(ref)) return platformRecipient(channel, ref);
  throw new Error('invalid claim recipient');
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
  const short = (err) => String(err && err.message ? err.message : err).slice(0, 160);
  const claimLink = (claim) => `${config.siteUrl}/claim/${claim.claim_token}`;

  async function processPayout(row) {
    const asset = ASSETS[String(row.asset || '')];
    if (!asset || !/^[1-9][0-9]*$/.test(String(row.amount || ''))) return fail(row, 'invalid_request');
    const amount = BigInt(row.amount);

    const { data: platform, error: platErr } = await supabase
      .from('api_platforms')
      .select('id, account_id, display_name, wallet_address, enabled, claim_expiry_default_days, claim_expiry_max_days')
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
    let toAddress = null;
    let toLabel;
    let claimRecipient = null;
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
    } else if (CLAIM_KINDS.includes(row.recipient_kind)) {
      try {
        claimRecipient = claimRecipientFor(row.recipient_kind, String(row.recipient_ref || ''));
      } catch {
        return fail(row, 'invalid_recipient');
      }
      toLabel = claimRecipientLabel(claimRecipient);
    } else {
      return fail(row, 'invalid_recipient');
    }
    if (toAddress && toAddress.toLowerCase() === String(platform.wallet_address).toLowerCase()) return fail(row, 'recipient_is_platform');

    const lock = await tryAccountTxLock(supabase, platform.account_id, 'api');
    if (!lock.ok) return later(row, 'another payment from this account is in progress');
    try {
      // The rolling day, counted under the lock so two payouts cannot both fit.
      const since = new Date(Date.now() - DAY_MS).toISOString();
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
        if (r.id === row.id || !COUNTED_STATES.includes(r.state)) continue;
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
        toIsAddress: !claimRecipient,
        chainId: String(chain.chainId),
        asset: native ? 'native' : asset.symbol,
      });
      const policyOpts = { enforceTrusted: false, apiPayout: true, accountRow, nativeSymbol: chain.nativeSymbol || 'ETH' };
      const policy = claimRecipient ? await evaluateClaimHoldPolicy(intent, policyOpts) : await evaluateSendPolicy(intent, policyOpts);
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
      const planChain = { chainId: chain.chainId, chainName: chain.name, nativeSymbol: chain.nativeSymbol || 'ETH' };
      const plan = claimRecipient
        ? buildClaimPlan({ intent, policy, chain: planChain, fromAddress, recipient: claimRecipient, fromBalanceEth, tokenAddress, tokenSymbol, tokenBalance })
        : buildSendPlan({ intent, policy, chain: planChain, fromAddress, fromBalanceEth, tokenAddress, tokenSymbol, tokenBalance, reason: row.reference || null });
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

      if (toAddress) await update(row.id, { to_address: toAddress.toLowerCase() });
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
      const permission = { send: sender.send, ownerKey: false };
      const notSent = (result) =>
        // Nothing reached the chain: a hash stored just before a broadcast that
        // never happened must not be shown as this payout's transaction.
        result.reason === ALLOWANCE_REASON
          ? fail(row, sender.decision.code || DECISION_CODES.noAllowance, { tx_hash: null })
          : fail(row, 'not_sent', { tx_hash: null });

      if (claimRecipient) {
        const days = Math.min(
          Number(row.claim_expiry_days) || Number(platform.claim_expiry_default_days) || 30,
          Number(platform.claim_expiry_max_days) || 30
        );
        const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
        const result = await executeClaimHold({
          fromAccountId: platform.account_id,
          fromWaSender: null,
          recipient: claimRecipient,
          amountEth: display,
          asset: native ? 'ETH' : asset.symbol,
          tokenAddress,
          provider,
          chain,
          permission,
          expiresAt,
          apiTransactionId: row.id,
        });
        if (result.ok) {
          await update(row.id, { claim_id: result.claim.id, claim_url: result.claimUrl, claim_expires_at: expiresAt, lease_until: null, error_code: null });
          await transition(row.id, 'claim_pending', { tx_hash: result.holdTxHash, claim_url: result.claimUrl, expires_at: expiresAt });
          await notifyClaimRecipient({ recipient: claimRecipient, platform, display, label: asset.label, expiresAt });
          return 'claim_pending';
        }
        if (result.submitted) {
          // The hold may have landed: the attempt reconciler writes the claim,
          // linked to this payout, and reconcile() picks it up from its hash.
          await update(row.id, { lease_until: null });
          log.warn(`[api-payout] ${row.id} hold sent, outcome not known yet`);
          return 'submitted';
        }
        return notSent(result);
      }

      const result = await executeNativeSend({
        plan,
        provider,
        chain,
        user: { id: null, balance_eth: 0 },
        supabase,
        permission,
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
      return notSent(result);
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
      log.warn(`[api-payout] recipient notice failed: ${short(err)}`);
    }
  }

  /** A claim recipient already on Flizy is told; nobody else is, and the platform is never told who is. */
  async function notifyClaimRecipient({ recipient, platform, display, label, expiresAt }) {
    try {
      let accountId = null;
      if (recipient.kind === 'phone') accountId = await findAccountIdByPhone(recipient.phone);
      else if (recipient.kind === 'email') accountId = await findAccountIdByEmail(recipient.email);
      else if (recipient.kind === 'platform') accountId = (await getAccountByIdentity(recipient.channel, recipient.externalId))?.account?.id || null;
      if (!accountId || accountId === platform.account_id) return;
      await notifyAccount(accountId, formatPartnerClaimNotice({ platformName: platform.display_name, amount: display, label, expiresAt }));
    } catch (err) {
      log.warn(`[api-payout] claim notice failed: ${short(err)}`);
    }
  }

  /** Payouts and holds with a hash that never settled: the receipt decides. */
  async function reconcile() {
    const before = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
    const { data: rows, error } = await supabase
      .from('api_transactions')
      .select('id, state, tx_hash, recipient_kind')
      .eq('kind', 'payout')
      .in('state', ['queued', 'submitted'])
      .not('tx_hash', 'is', null)
      .lt('updated_at', before)
      .limit(10);
    if (error) throw new Error(error.message);
    for (const row of rows || []) {
      const receipt = await provider.getTransactionReceipt(row.tx_hash);
      if (!receipt) continue;
      if (receipt.status !== 1) {
        if (row.state === 'queued') await transition(row.id, 'submitted', { tx_hash: row.tx_hash });
        await update(row.id, { error_code: 'reverted', lease_until: null });
        await transition(row.id, 'failed', { error_code: 'reverted' });
        continue;
      }
      if (CLAIM_KINDS.includes(row.recipient_kind)) {
        // The hold landed. Its claim is written by the attempt reconciler
        // (lib/reconcile.js), already linked to this payout; wait for it.
        const { data: claim } = await supabase
          .from('claims')
          .select('id, claim_token, expires_at')
          .eq('hold_tx_hash', row.tx_hash)
          .eq('api_transaction_id', row.id)
          .maybeSingle();
        if (!claim) continue;
        if (row.state === 'queued') await transition(row.id, 'submitted', { tx_hash: row.tx_hash });
        await update(row.id, { claim_id: claim.id, claim_url: claimLink(claim), claim_expires_at: claim.expires_at, lease_until: null });
        await transition(row.id, 'claim_pending', { tx_hash: row.tx_hash, claim_url: claimLink(claim), expires_at: claim.expires_at });
        continue;
      }
      if (row.state === 'queued') await transition(row.id, 'submitted', { tx_hash: row.tx_hash });
      await update(row.id, { lease_until: null });
      await transition(row.id, 'confirmed', { tx_hash: row.tx_hash });
    }
  }

  /**
   * API claims after their hold: claimed by the recipient, cancelled in chat,
   * past their expiry, or cancelled by the platform. The claim is locked
   * (pending -> processing) before the payout says it is refunding, and stays
   * locked until the refund is confirmed, so the recipient can never claim a
   * payout that reads as refunding.
   */
  async function watchClaims() {
    const { data: rows, error } = await supabase
      .from('api_transactions')
      .select('id, state, platform_id, claim_id, cancel_requested_at, refund_tx_hash, updated_at')
      .eq('kind', 'payout')
      .in('state', ['claim_pending', 'expired', 'refund_pending'])
      .lt('updated_at', new Date(Date.now() - CLAIM_RECHECK_MS).toISOString())
      .order('updated_at', { ascending: true })
      .limit(CLAIMS_PER_TICK);
    if (error) throw new Error(error.message);
    for (const row of rows || []) {
      try {
        // A claim still waiting for its recipient is marked as looked at, so
        // the oldest few never crowd out the rest.
        if ((await settleClaim(row)) === 'idle') await update(row.id, {});
      } catch (err) {
        log.warn(`[api-payout] claim ${row.id}: ${short(err)}`);
      }
    }
  }

  async function settleClaim(row) {
    if (!row.claim_id) return;
    const claim = await getClaimById(row.claim_id);
    if (!claim || String(claim.api_transaction_id || '') !== String(row.id)) return;
    const { data: platform } = await supabase.from('api_platforms').select('id, account_id').eq('id', row.platform_id).maybeSingle();
    if (!platform) return;

    if (row.state === 'claim_pending') {
      if (claim.status === 'claimed') {
        await transition(row.id, 'confirmed', { claim_tx_hash: claim.claim_tx_hash || claim.tx_hash || null });
        return;
      }
      if (claim.status === 'cancelled') {
        // The platform's owner cancelled it in chat; that refund is already
        // confirmed on chain (lib/engine/executeClaim.js executeClaimRefund).
        await update(row.id, { refund_tx_hash: claim.refund_tx_hash || null });
        await transition(row.id, 'refund_pending', { reason: 'cancelled_in_chat' });
        await transition(row.id, 'refunded', { refund_tx_hash: claim.refund_tx_hash || null });
        return;
      }
      if (claim.status !== 'pending') return;
      const expired = Boolean(claim.expires_at) && Date.parse(claim.expires_at) <= Date.now();
      if (!expired && !row.cancel_requested_at) return 'idle';
      // Locked first: if the recipient got there, the claim is theirs.
      if (!(await beginClaimProcessing(claim.id))) return;
      if (expired) await transition(row.id, 'expired', {});
      await transition(row.id, 'refund_pending', { reason: expired ? 'expired' : 'cancelled' });
      return refund(row, platform);
    }
    if (row.state === 'expired') {
      // Expired but the lock was not taken yet (a crash between the two).
      if (claim.status === 'pending' && !(await beginClaimProcessing(claim.id))) return;
      if (claim.status !== 'pending' && claim.status !== 'processing') return;
      await transition(row.id, 'refund_pending', { reason: 'expired' });
      return refund(row, platform);
    }
    // refund_pending
    if (claim.status === 'cancelled') {
      await transition(row.id, 'refunded', { refund_tx_hash: claim.refund_tx_hash || row.refund_tx_hash || null });
      return;
    }
    if (row.refund_tx_hash) return settleRefund(row, claim, platform);
    if (claim.status === 'pending' && !(await beginClaimProcessing(claim.id))) return;
    return refund(row, platform);
  }

  /** The refund itself, from escrow to the platform's wallet, with its hash stored before the broadcast. */
  async function refund(row, platform) {
    const out = await executeClaimRefund({
      claimId: row.claim_id,
      fromAccountId: platform.account_id,
      provider,
      chain,
      held: true,
      onBroadcast: (hash) => update(row.id, { refund_tx_hash: hash }),
    });
    if (out.ok) {
      await transition(row.id, 'refunded', { refund_tx_hash: out.refundTxHash });
      return;
    }
    // Nothing moved: a hash stored for it points at nothing, and the next pass
    // sends again. Anything else keeps the hash for the receipt check, so a
    // refund that may have moved money is never sent twice.
    if (out.outcome === 'not_sent' || out.outcome === 'reverted') await update(row.id, { refund_tx_hash: null });
    log.warn(`[api-payout] ${row.id} refund not done yet: ${String(out.error || '').slice(0, 120)}`);
  }

  /** A refund whose outcome was unknown: confirmed, it cancels the claim; reverted, it is tried again. */
  async function settleRefund(row, claim, platform) {
    if (Date.now() - Date.parse(row.updated_at) < RECONCILE_AFTER_MS) return;
    const receipt = await provider.getTransactionReceipt(row.refund_tx_hash);
    if (!receipt) return;
    if (receipt.status === 1) {
      const done = await cancelClaim(claim.id, platform.account_id, row.refund_tx_hash);
      if (done.ok || claim.status === 'cancelled') await transition(row.id, 'refunded', { refund_tx_hash: row.refund_tx_hash });
      return;
    }
    // Mined and reverted: nothing moved. The claim stays locked; the next pass sends again.
    await update(row.id, { refund_tx_hash: null });
  }

  /** One pass: settle what was sent, watch claims, then take up to PER_TICK payouts in order. Never throws. */
  async function tick() {
    try {
      await reconcile();
    } catch (err) {
      log.warn(`[api-payout] reconcile: ${short(err)}`);
    }
    try {
      await watchClaims();
    } catch (err) {
      log.warn(`[api-payout] claims: ${short(err)}`);
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
        log.error(`[api-payout] ${row.id}: ${short(err)}`);
        break;
      }
    }
    return done;
  }

  return { tick, processPayout, reconcile, watchClaims };
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

module.exports = { makeWorker, startApiPayoutWorker, plainAmount, ASSETS, CLAIM_KINDS };
