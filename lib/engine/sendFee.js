/**
 * The Flizy fee on a chat send (Phase 0d).
 *
 * Quoted when the plan is made and carried in it, so what the person confirms
 * is what is charged: plan.fee holds the quote (lib/feeQuote.js), the fee
 * treasury, and the amounts in the asset. The executors read it from there
 * (lib/engine/executeTransfer.js): the payment and the fee go in one
 * all-or-nothing UserOp, or one redeemDelegations under the passkey
 * permission, and every check that guards the balance and the limits is held
 * to the payment plus the fee.
 *
 * Applies to a person-to-person send of ETH, FLZ or tUSD from a smart-account
 * wallet, only with FEES_ENABLED, including a payment for a request or into a
 * pot, and a hold for someone not on Flizy yet (a claim): its fee is charged
 * with the hold and kept if the claim is cancelled or expires, and its ledger
 * source is the hold attempt (claim_hold_attempts). Not to NFTs, and not from
 * an older plain wallet, which cannot make the payment and the fee in one
 * transaction. With fees off, nothing here changes a plan.
 *
 * When the spendable balance (after Savings and the gas reserve) does not
 * cover the payment and the fee, the fee comes out of the amount and the
 * preview says what the recipient gets. A request or pot payment must arrive
 * in full, so there it is refused instead. Below the fee, the send is refused.
 */

const { ethers } = require('ethers');
const fees = require('../fees');
const { quoteP2pFee, openFee, settleFee, waiveFee, claimFee, pendingFee, gasPaidWei, feeDecimals } = require('../feeQuote');
const { reservedOf, availableBase } = require('../reserves');
const { pointerIsGator } = require('../gatorExecute');
const { gatorAddresses } = require('../gatorAccount');
const { symbolLabel } = require('../listedTokens');
const { publicErrorMessage } = require('../sanitize');

const FEE_ASSETS = new Set(['ETH', 'FLZ', 'TUSD']);

const COPY = Object.freeze({
  unavailable: 'Could not work out the fee right now, so nothing was sent. Try again shortly.',
  settings: 'Payments are paused for a moment, so nothing was sent. Try again shortly.',
  balance: 'Could not verify wallet balance.',
});

/**
 * The fee settings when fees are on, or null when off. Off, nothing is parsed,
 * so a payment is never affected by a fee setting. On, malformed settings
 * throw: a payment is never sent without its fee.
 */
function activeFeeConfig(env = process.env) {
  if (String(env.FEES_ENABLED || '').trim().toLowerCase() !== 'true') return null;
  return fees.feeConfig(env);
}

/** Does this plan carry a fee once fees are on? A send or a claim hold, never an NFT. */
function feeApplies(plan, accountId) {
  if (!plan) return false;
  const kind = plan.route && plan.route.kind;
  const send = plan.intent === 'SEND' && (kind === 'native_transfer' || kind === 'erc20_transfer');
  const hold = plan.intent === 'CLAIM_HOLD' && kind === 'claim_hold' && !plan.route.nftTokenId;
  if (!send && !hold) return false;
  if (!FEE_ASSETS.has(String(plan.input.asset || '').toUpperCase())) return false;
  return pointerIsGator(accountId, plan.route.fromAddress);
}

/**
 * Quote the fee and fit it to the balance, writing plan.fee (and, when the fee
 * comes out of the amount, plan.input.amount).
 * @param {{ plan: object, supabase: object, provider: object, chainKey: string, accountId: string,
 *   ethBalanceWei: bigint, tokenBalanceUnits?: bigint|null, gasBufferWei: bigint, env?: object, log?: object }} p
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function attachSendFee({ plan, supabase, provider, chainKey, accountId, ethBalanceWei, tokenBalanceUnits = null, gasBufferWei, env = process.env, log = console }) {
  let cfg;
  try {
    cfg = activeFeeConfig(env);
  } catch (err) {
    log.error(`[fees] settings refused, so no send is planned: ${publicErrorMessage(err)}`);
    return { ok: false, message: COPY.settings };
  }
  if (!cfg || !feeApplies(plan, accountId)) return { ok: true };

  const asset = String(plan.input.asset).toUpperCase();
  const native = plan.route.kind === 'native_transfer' || (plan.route.kind === 'claim_hold' && !plan.route.tokenAddress);
  const decimals = feeDecimals(asset);
  let amountUnits;
  try {
    amountUnits = ethers.parseUnits(String(plan.input.amount), decimals);
  } catch {
    return { ok: false, message: 'Invalid amount.' };
  }

  let quote;
  try {
    quote = await quoteP2pFee({ supabase, provider, asset, amountUnits, chainKey, cfg, log });
  } catch (err) {
    log.warn(`[fees] quote failed: ${publicErrorMessage(err)}`);
    return { ok: false, message: COPY.unavailable };
  }
  const feeUnits = BigInt(quote.feeUnits);

  const reserved = await reservedOf(supabase, accountId, asset);
  if (!reserved.ok) return { ok: false, message: COPY.balance };
  const holding = native ? BigInt(ethBalanceWei) : tokenBalanceUnits == null ? null : BigInt(tokenBalanceUnits);
  if (holding == null) return { ok: false, message: COPY.balance };
  const spendable = availableBase(holding, reserved.amount, native ? BigInt(gasBufferWei) : 0n);

  const planned = fees.planAmounts({ amountUnits, feeUnits, balanceUnits: spendable });
  const label = symbolLabel(asset);
  if (!planned.ok && planned.reason === 'below_fee') {
    return { ok: false, message: `Your balance is below the ${quote.feeText} fee, so nothing was sent.` };
  }
  if (!planned.ok && planned.reason === 'amount_below_fee') {
    return { ok: false, message: `The amount has to be more than the ${quote.feeText} fee (${ethers.formatUnits(feeUnits, decimals)} ${label}).` };
  }
  // A request or pot payment must arrive in full: the fee is never taken from it.
  if (planned.ok && planned.feeFromAmount && (plan.paymentRequestId || plan.potId)) {
    return {
      ok: false,
      message: `This needs ${plan.input.amount} ${label} plus the ${quote.feeText} fee (${ethers.formatUnits(feeUnits, decimals)} ${label}), and your balance does not cover both, so nothing was sent.`,
    };
  }
  // Not enough for the payment itself: the fee goes on top, and the balance
  // checks that follow refuse it with the usual message.
  const sendUnits = planned.ok ? planned.sendUnits : amountUnits;
  const feeFromAmount = planned.ok ? planned.feeFromAmount : false;
  const requested = String(plan.input.amount);
  if (feeFromAmount) plan.input.amount = ethers.formatUnits(sendUnits, decimals);
  plan.fee = {
    ...quote,
    treasury: cfg.treasury,
    sendUnits: sendUnits.toString(),
    totalUnits: (sendUnits + feeUnits).toString(),
    feeHuman: ethers.formatUnits(feeUnits, decimals),
    sendHuman: ethers.formatUnits(sendUnits, decimals),
    totalHuman: ethers.formatUnits(sendUnits + feeUnits, decimals),
    requestedHuman: requested,
    feeFromAmount,
  };
  // A claim hold plan carries no estimate block.
  if (plan.estimated) plan.estimated.fees = `Flizy fee ${quote.feeText}, network gas`;
  return { ok: true };
}

/** The fee a plan carries in raw units, with its treasury, or null. */
function planFee(plan) {
  const f = plan && plan.fee;
  if (!f || f.feeUnits == null || !f.treasury) return null;
  return { units: BigInt(f.feeUnits), treasury: ethers.getAddress(f.treasury), quote: f };
}

/** The preview lines for a plan's fee, or none. */
function feePreviewLines(plan) {
  const f = plan && plan.fee;
  if (!f) return [];
  const label = symbolLabel(f.asset);
  if (f.feeFromAmount) {
    return [
      `Fee:     ${f.feeHuman} ${label} (${f.feeText}), taken from the ${f.requestedHuman} ${label} you asked to send`,
      `They get: ${f.sendHuman} ${label}`,
      `Total:   ${f.totalHuman} ${label}`,
    ];
  }
  return [`Fee:     ${f.feeHuman} ${label} (${f.feeText})`, `Total:   ${f.totalHuman} ${label}`];
}

/**
 * The plan's fee on record as pending, before its payment is sent, so a payment
 * whose outcome is not known yet still has its fee. Throws when it cannot be
 * written: the caller then sends nothing.
 */
async function openSendFee({ plan, transferId, supabase }) {
  const fee = planFee(plan);
  if (!fee) return;
  if (!transferId) throw new Error('no transfer row to hold the fee');
  await openFee({ supabase, sourceKind: 'transfer', sourceId: transferId, accountId: plan.actor.accountId, quote: fee.quote });
}

/** Gas Flizy paid for a landed payment: with the top-up on, a wallet's UserOp cost counts as Flizy's. */
function paidGas({ path, receipt, gator, env }) {
  const { topupConfig } = require('../gasTopup');
  let toppedUp = false;
  try {
    toppedUp = topupConfig(env).enabled;
  } catch {
    toppedUp = false;
  }
  return gasPaidWei({ path, toppedUp, receipt, entryPoint: gatorAddresses().entryPointV07, gator });
}

/**
 * The fee landed with its payment: charged. Never throws: the money has moved,
 * so a failure here is logged for the operator and nothing else.
 */
async function settleSendFee({ plan, transferId, txHash, receipt, path, gator, supabase, env = process.env, log = console }) {
  if (!planFee(plan) || !transferId) return;
  await settleSourceFee({ sourceKind: 'transfer', sourceId: transferId, txHash, receipt, path, gator, supabase, env, log });
}

/** The payment was not sent, or reverted: its pending fee is waived. Never throws. */
async function waiveSendFee({ plan, transferId, supabase, reason, log = console }) {
  if (!planFee(plan) || !transferId) return;
  await waiveSourceFee({ sourceKind: 'transfer', sourceId: transferId, supabase, reason, log });
}

/** A pending fee of any source that landed: charged. Never throws. */
async function settleSourceFee({ sourceKind, sourceId, txHash, receipt, path, gator, supabase, env = process.env, log = console }) {
  try {
    await settleFee({ supabase, sourceKind, sourceId, txHash, gasPaid: paidGas({ path, receipt, gator, env }), cfg: fees.feeConfig(env) });
  } catch (err) {
    log.error(`[fees] a charged fee was not settled in the ledger: ${publicErrorMessage(err)}`);
  }
}

/** A pending fee of any source that was not charged: waived. Never throws. */
async function waiveSourceFee({ sourceKind, sourceId, supabase, reason, log = console }) {
  try {
    await waiveFee({ supabase, sourceKind, sourceId, reason });
  } catch (err) {
    log.error(`[fees] a fee that was not charged is still pending: ${publicErrorMessage(err)}`);
  }
}

/**
 * After a passkey-approved payment lands (lib/custody/approvals.js): its fee,
 * still pending, is collected through the account's daily permission, or
 * waived when it cannot be. What the passkey signed stays exactly the payment;
 * the fee is never sent on the owner key. It is sent at most once: the run
 * that claims it (lib/feeQuote.js claimFee) sends it, any other stops. Never
 * throws.
 */
async function collectApprovedFee({ supabase, provider, transferId, accountId, gator, env = process.env, log = console }) {
  if (!transferId) return;
  let pending;
  try {
    pending = await pendingFee({ supabase, sourceKind: 'transfer', sourceId: transferId });
  } catch (err) {
    log.error(`[fees] could not read an approved payment's fee: ${publicErrorMessage(err)}`);
    return;
  }
  if (!pending) return;
  const waive = async (reason) => {
    log.warn(`[fees] an approved payment's fee was waived: ${reason}`);
    try {
      await waiveFee({ supabase, sourceKind: 'transfer', sourceId: transferId, reason });
    } catch (err) {
      log.error(`[fees] a waived fee is still pending: ${publicErrorMessage(err)}`);
    }
  };
  let cfg;
  try {
    cfg = activeFeeConfig(env);
  } catch (err) {
    return waive(`settings refused (${publicErrorMessage(err)})`);
  }
  if (!cfg) return waive('fees are off');
  // The approval worker and the reconciler can both reach here for one
  // payment; only the run that claims the fee sends it.
  try {
    if (!(await claimFee({ supabase, sourceKind: 'transfer', sourceId: transferId }))) return;
  } catch (err) {
    log.error(`[fees] could not claim an approved payment's fee, not sent: ${publicErrorMessage(err)}`);
    return;
  }
  const { trySendWithPermission } = require('../custody/redeem');
  let out;
  try {
    out = await trySendWithPermission({ supabase, provider, accountId, wallet: gator, symbol: pending.asset, amount: BigInt(pending.fee_units), to: cfg.treasury, log });
  } catch (err) {
    // Sent with no answer: it may land. The fee stays pending for the operator.
    log.error(`[fees] an approved payment's fee was sent with no answer, left pending: ${publicErrorMessage(err)}`);
    return;
  }
  if (!out || out.route !== 'permission') {
    return waive(out ? `the daily permission refused it (${out.route})` : 'the relayer could not send it');
  }
  try {
    await settleFee({ supabase, sourceKind: 'transfer', sourceId: transferId, txHash: out.txHash, gasPaid: gasPaidWei({ path: 'relayer', receipt: out.receipt }), cfg });
  } catch (err) {
    log.error(`[fees] a collected fee was not settled in the ledger: ${publicErrorMessage(err)}`);
  }
}

module.exports = {
  activeFeeConfig,
  feeApplies,
  attachSendFee,
  planFee,
  feePreviewLines,
  openSendFee,
  settleSendFee,
  waiveSendFee,
  settleSourceFee,
  waiveSourceFee,
  collectApprovedFee,
  FEE_ASSETS,
};
