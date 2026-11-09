/**
 * Pay a Flizy Pay API checkout from chat, from the account's own Flizy wallet.
 *
 * The chat side of POST /api/checkout/{id}/pay (web): the same controls, in the
 * same order. The amount is what the checkout still lacks, read again under the
 * account lock, never a number from the chat. It goes through
 * FlizyPaymentReceiver with the checkout's invoice id, straight to the
 * platform's wallet, so it settles exactly as any wallet's payment does: the
 * receipt's PaymentReceived log is recorded once by api_record_payment (the
 * watcher's recordLog), and if that fails the watcher settles it from the chain.
 *
 * A secured account's daily permission can only redeem a plain transfer, so it
 * cannot make this call, and the payment goes on the owner key as on the site.
 * In chat it is therefore held to what is left of today's passkey allowance,
 * less the checkout payments the allowance never saw: over that, nothing is
 * sent and the payer is pointed at the checkout page.
 */

const { ethers } = require('ethers');
const deployment = require('../../deployments/giwa-sepolia.json');
const { resolveListedSendAsset } = require('../dex');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { GatorExecError, pointerIsGator, gatorGasReserveWei, executeGatorCall, executeApprovalCall, outcomeUnknown, gatorErrorCopy } = require('../gatorExecute');
const { predictGatorAddress } = require('../gatorAccount');
const { planPermissionSend, relayerWallet } = require('../custody/redeem');
const { explorerTxUrl } = require('../chains');
const { publicErrorMessage, displaySafeLabel } = require('../sanitize');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt, recordBroadcast } = require('../transferLog');
const { FUND_REASON, fundingWallText } = require('../engine/fundingWall');
const { assertSpendable } = require('../reserves');
const { checkDailySendLimitNow } = require('../dailyLimits');
const { makePaymentWatcher } = require('./paymentWatcher');

const RECEIVER = ethers.getAddress(deployment.paymentReceiver.address);
const RECEIVER_IFACE = new ethers.Interface([
  'function payNative(bytes32 invoiceId, address payee) payable',
  'function payToken(bytes32 invoiceId, address token, address payee, uint256 amount)',
]);
const ERC20 = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSETS = Object.freeze({
  ETH: { label: 'ETH', decimals: 18 },
  FLZ: { label: 'FLZ', decimals: 18 },
  TUSD: { label: 'tUSD', decimals: 6 },
});

/** Base units as a plain number string: no trailing ".0". */
function plainUnits(units, decimals) {
  const s = ethers.formatUnits(units, decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** The token a checkout is paid in; null for ETH. */
function tokenFor(asset, chainKey) {
  if (asset === 'ETH') return null;
  return ethers.getAddress(resolveListedSendAsset(asset, chainKey).tokenAddress);
}

/** The checkout page, where a payment chat will not make can still be made. */
function checkoutUrl(id) {
  return `${config.siteUrl}/checkout/${id}`;
}

/**
 * What chat needs about a checkout, or null when there is none. Like the page,
 * never the platform's reference or metadata.
 */
async function loadCheckout(supabase, id, chainKey) {
  if (!UUID.test(String(id || ''))) return null;
  const { data: row, error } = await supabase
    .from('api_transactions')
    .select('id, platform_id, state, amount, asset, received_units, invoice_id, expires_at')
    .eq('id', id)
    .eq('kind', 'payment')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !ASSETS[row.asset]) return null;
  const { data: platform, error: pErr } = await supabase
    .from('api_platforms')
    .select('account_id, display_name, wallet_address, enabled')
    .eq('id', row.platform_id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!platform) return null;
  const amountUnits = BigInt(row.amount);
  const receivedUnits = BigInt(String(row.received_units ?? 0));
  return {
    id: row.id,
    state: row.state,
    platformName: displaySafeLabel(platform.display_name, 60) || 'A Flizy partner',
    asset: row.asset,
    assetLabel: ASSETS[row.asset].label,
    decimals: ASSETS[row.asset].decimals,
    amountUnits,
    receivedUnits,
    dueUnits: amountUnits > receivedUnits ? amountUnits - receivedUnits : 0n,
    payee: ethers.getAddress(platform.wallet_address),
    invoiceId: row.invoice_id,
    token: tokenFor(row.asset, chainKey),
    expiresAt: row.expires_at,
    platformEnabled: platform.enabled === true,
    platformAccountId: platform.account_id,
  };
}

/** Why a checkout cannot be paid from this account, or null when it can. */
function refusal(view, accountId, now = Date.now()) {
  if (!view) return 'That checkout was not found.';
  if (view.state !== 'accepted' || Date.parse(view.expiresAt) <= now || !view.platformEnabled) {
    return 'This checkout is no longer open.';
  }
  if (String(view.platformAccountId) === String(accountId)) return 'You cannot pay your own checkout.';
  if (view.dueUnits <= 0n) return 'This checkout is already paid.';
  return null;
}

/** A numeric column's text as base units, rounded up so a sum never comes out short. */
function textToUnits(text, decimals) {
  const [whole, frac = ''] = String(text ?? '0').trim().split('.');
  const units = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'));
  return /[1-9]/.test(frac.slice(decimals)) ? units + 1n : units;
}

/**
 * This account's checkout payments in this asset over the last 24 hours, on
 * the site or in chat, not failed. They go on the owner key, so the
 * permission's own period never counts them; one period is a day, so 24 hours
 * back covers whichever window is current.
 */
async function recentCheckoutUnits(supabase, accountId, asset, decimals, now = Date.now()) {
  const { data, error } = await supabase
    .from('transfers')
    .select('amount_eth')
    .eq('account_id', accountId)
    .eq('note', 'Checkout')
    .eq('asset', asset)
    .in('status', ['pending', 'submitted', 'confirmed'])
    .gte('created_at', new Date(now - 24 * 3600 * 1000).toISOString());
  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, row) => sum + textToUnits(row.amount_eth, decimals), 0n);
}

/**
 * Over today's passkey allowance? Only a secured account has one; any other
 * account answers over: false. What is left is what the permission reports,
 * less the checkout payments it cannot see, so paying one checkout after
 * another cannot pass it. A check that cannot be made throws, and the caller
 * sends nothing.
 */
async function overPasskeyAllowance({ supabase, provider, accountId, wallet, asset, amount, planSend = planPermissionSend }) {
  const plan = await planSend({ supabase, provider, accountId, wallet, symbol: asset, amount, relayer: relayerWallet(provider) });
  if (plan.route === 'owner') return { over: false };
  const spent = await recentCheckoutUnits(supabase, accountId, asset, ASSETS[asset].decimals);
  const left = plan.available > spent ? plan.available - spent : 0n;
  return amount > left ? { over: true, available: left } : { over: false };
}

function overAllowanceCopy(view, available) {
  return [
    `This is more than your passkey allows today (${plainUnits(available, view.decimals)} ${view.assetLabel} left), so it was not sent.`,
    'Checkout payments in chat cannot wait for a passkey approval. Pay it on the checkout page instead:',
    checkoutUrl(view.id),
  ].join('\n');
}

/** The account's wallet: its HybridDeleGator, or the EOA before migration. */
async function payerWallet(accountId, provider) {
  const account = await ensureAgentWallet(accountId);
  const viaGator = pointerIsGator(accountId, account.agent_wallet_address);
  const signer = getAgentSigner(accountId, provider);
  return { viaGator, signer, walletAddr: viaGator ? predictGatorAddress(accountId) : signer.address };
}

/**
 * Pay what the checkout still lacks. The caller holds the account lock.
 *
 * @returns {Promise<{ok: boolean, submitted?: boolean, reason?: string, error?: string,
 *   txHash?: string, explorerUrl?: string, paid?: string, settled?: boolean, view?: object}>}
 *   `submitted` true means it may have moved: never say "not sent".
 */
async function payCheckout({ supabase, provider, chain, accountId, checkoutId, phone }) {
  // Read again under the lock: a payment that landed since leaves less to pay,
  // or nothing. Never more, so the tier the preview worked out still covers it.
  const view = await loadCheckout(supabase, checkoutId, chain.id);
  const refused = refusal(view, accountId);
  if (refused) return { ok: false, submitted: false, error: refused };
  const due = view.dueUnits;
  const native = view.asset === 'ETH';
  const dueHuman = plainUnits(due, view.decimals);

  const { viaGator, signer, walletAddr } = await payerWallet(accountId, provider);
  if (viaGator) {
    let cap;
    try {
      cap = await overPasskeyAllowance({ supabase, provider, accountId, wallet: walletAddr, asset: view.asset, amount: due });
    } catch (err) {
      console.error('checkout passkey allowance:', publicErrorMessage(err));
      return { ok: false, submitted: false, error: 'Could not check your passkey allowance right now, so nothing was sent. Try again shortly.' };
    }
    if (cap.over) return { ok: false, submitted: false, error: overAllowanceCopy(view, cap.available) };
  }

  const ethBal = await provider.getBalance(walletAddr);
  const gasBuf = viaGator ? await gatorGasReserveWei(provider, walletAddr) : ethers.parseEther(config.gasBufferEth);
  if (native) {
    const fence = await assertSpendable(supabase, accountId, { asset: 'ETH', holding: ethBal, amount: due, gas: gasBuf, decimals: 18, label: 'ETH' });
    if (!fence.ok) return { ok: false, submitted: false, error: fence.message };
    if (ethBal < due + gasBuf) return { ok: false, submitted: false, reason: FUND_REASON, error: fundingWallText({ kind: 'native', address: walletAddr }) };
    const daily = await checkDailySendLimitNow(accountId, ethers.formatEther(due));
    if (!daily.ok) return { ok: false, submitted: false, error: daily.message || 'Daily send limit reached.' };
  } else {
    const gasFence = await assertSpendable(supabase, accountId, { asset: 'ETH', holding: ethBal, amount: 0n, gas: gasBuf, decimals: 18, label: 'ETH' });
    if (!gasFence.ok) return { ok: false, submitted: false, error: gasFence.message };
    if (ethBal < gasBuf) return { ok: false, submitted: false, reason: FUND_REASON, error: fundingWallText({ kind: 'gas', address: walletAddr }) };
    const tokBal = BigInt(await provider.call({ to: view.token, data: ERC20.encodeFunctionData('balanceOf', [walletAddr]) }));
    const fence = await assertSpendable(supabase, accountId, { asset: view.asset, holding: tokBal, amount: due, gas: 0n, decimals: view.decimals, label: view.assetLabel });
    if (!fence.ok) return { ok: false, submitted: false, error: fence.message };
    if (tokBal < due) return { ok: false, submitted: false, reason: FUND_REASON, error: fundingWallText({ kind: 'token', asset: view.asset, address: walletAddr }) };
  }

  const rowPayload = {
    account_id: accountId,
    phone,
    to_address: view.payee,
    amount_eth: dueHuman,
    status: 'pending',
    chain_id: chain.chainId,
    kind: 'transfer',
    asset: view.asset,
    token_address: view.token,
    counterparty_label: `${view.platformName} (Flizy partner)`,
    direction: 'out',
    note: 'Checkout',
  };
  let transferRow = await insertTransfer(rowPayload);

  let payBroadcast = false;
  try {
    // A token first gets an exact approval for the receiver (an approval moves
    // no value and records nothing); then one call into the receiver pays. The
    // receiver only pulls from the wallet that calls it.
    if (!native) {
      const allowed = BigInt(await provider.call({ to: view.token, data: ERC20.encodeFunctionData('allowance', [walletAddr, RECEIVER]) }));
      if (allowed < due) {
        const approveData = ERC20.encodeFunctionData('approve', [RECEIVER, due]);
        if (viaGator) {
          await executeApprovalCall({ accountId, provider, chainId: chain.chainId, target: view.token, value: 0n, data: approveData });
        } else {
          const approval = await (await signer.sendTransaction({ to: view.token, data: approveData })).wait(1);
          if (!approval || approval.status !== 1) throw new Error('approval reverted');
        }
      }
    }
    const payData = native
      ? RECEIVER_IFACE.encodeFunctionData('payNative', [view.invoiceId, view.payee])
      : RECEIVER_IFACE.encodeFunctionData('payToken', [view.invoiceId, view.token, view.payee, due]);
    const payValue = native ? due : 0n;

    let txHash;
    let receipt;
    if (viaGator) {
      const sent = await executeGatorCall({
        accountId,
        provider,
        chainId: chain.chainId,
        target: RECEIVER,
        value: payValue,
        data: payData,
        // Persisted before broadcast: an unknown outcome always has a row.
        onBroadcast: async (hash) => {
          transferRow = { id: await recordBroadcast(transferRow?.id, hash, rowPayload) };
          payBroadcast = true;
        },
      });
      txHash = sent.txHash;
      receipt = sent.receipt;
    } else {
      const tx = await signer.sendTransaction({ to: RECEIVER, value: payValue, data: payData });
      payBroadcast = true;
      txHash = tx.hash;
      await logSubmitted(transferRow?.id, txHash);
      try {
        receipt = await tx.wait(1);
      } catch (waitErr) {
        // A mined revert moved nothing; anything else may still confirm.
        if (waitErr?.code === 'CALL_EXCEPTION') throw waitErr;
        throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet for the payment', { submitted: true, txHash });
      }
      if (!receipt || receipt.status !== 1) throw new Error('payment reverted');
    }
    await logReceipt(transferRow?.id, { ok: true, txHash });

    // The money has moved: a failure to record it here is only logged, and the
    // watcher settles it from the chain.
    try {
      const watcher = makePaymentWatcher({ supabase, provider, chain });
      const payments = new Map([[String(view.invoiceId).toLowerCase(), { id: view.id, asset: view.asset, accountId: view.platformAccountId, wallet: view.payee }]]);
      for (const entry of receipt.logs || []) {
        if (ethers.getAddress(entry.address) !== RECEIVER) continue;
        await watcher.recordLog(entry, payments);
      }
    } catch (err) {
      console.warn('checkout record (the watcher settles it):', publicErrorMessage(err));
    }
    const now = await loadCheckout(supabase, view.id, chain.id).catch(() => null);
    return {
      ok: true,
      txHash,
      explorerUrl: explorerTxUrl(chain, txHash),
      paid: dueHuman,
      settled: now?.state === 'confirmed',
      view: now || view,
    };
  } catch (err) {
    console.error('payCheckout:', publicErrorMessage(err));
    // Broadcast with no answer: it may have paid. The row stays 'submitted'
    // for the reconciler. An unconfirmed approval paid nothing.
    if (outcomeUnknown(err) && payBroadcast) {
      return { ok: false, submitted: true, txHash: err.txHash, error: gatorErrorCopy(err) };
    }
    if (transferRow?.id) {
      await logReceipt(transferRow.id, { ok: false, txHash: err?.txHash || '', error: 'not sent' });
    }
    return {
      ok: false,
      submitted: false,
      error: (outcomeUnknown(err) ? null : gatorErrorCopy(err)) || 'The payment did not go through, so nothing was paid. Try again shortly.',
    };
  }
}

module.exports = {
  RECEIVER,
  UUID,
  plainUnits,
  checkoutUrl,
  loadCheckout,
  refusal,
  textToUnits,
  recentCheckoutUnits,
  overPasskeyAllowance,
  overAllowanceCopy,
  payerWallet,
  payCheckout,
};
