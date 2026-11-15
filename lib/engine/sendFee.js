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
 * wallet, only with FEES_ENABLED. Not to NFTs, not to a request or pot payment
 * (those come later), and not from an older plain wallet, which cannot make
 * the payment and the fee in one transaction. With fees off, nothing here
 * changes a plan.
 *
 * When the spendable balance (after Savings and the gas reserve) does not
 * cover the payment and the fee, the fee comes out of the amount and the
 * preview says what the recipient gets. Below the fee, the send is refused.
 */

const { ethers } = require('ethers');
const fees = require('../fees');
const { quoteP2pFee, recordFee, gasPaidWei, feeDecimals } = require('../feeQuote');
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

/** Does this plan carry a fee once fees are on? */
function feeApplies(plan, accountId) {
  if (!plan || plan.intent !== 'SEND') return false;
  if (plan.paymentRequestId || plan.potId) return false;
  const kind = plan.route && plan.route.kind;
  if (kind !== 'native_transfer' && kind !== 'erc20_transfer') return false;
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
  const native = plan.route.kind === 'native_transfer';
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
  plan.estimated.fees = `Flizy fee ${quote.feeText}, network gas`;
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
 * The ledger row for a fee whose payment has landed. Never throws: the money
 * has moved, so a failure here is logged for the operator and nothing else.
 * @param {{ plan: object, transferId: string|null, txHash: string, receipt: object, path: 'relayer'|'wallet', gator: string, supabase: object, log?: object }} p
 */
async function recordSendFee({ plan, transferId, txHash, receipt, path, gator, supabase, env = process.env, log = console }) {
  const fee = planFee(plan);
  if (!fee || !transferId) return;
  try {
    const { topupConfig } = require('../gasTopup');
    let toppedUp = false;
    try {
      toppedUp = topupConfig(env).enabled;
    } catch {
      toppedUp = false;
    }
    // With the top-up on, a wallet's deposit is Flizy's money, so its UserOp
    // cost is counted as gas Flizy paid.
    const gasPaid = gasPaidWei({ path, toppedUp, receipt, entryPoint: gatorAddresses().entryPointV07, gator });
    await recordFee({ supabase, sourceKind: 'transfer', sourceId: transferId, accountId: plan.actor.accountId, txHash, quote: fee.quote, gasPaid, cfg: fees.feeConfig(env) });
  } catch (err) {
    log.error(`[fees] a charged fee was not recorded in the ledger: ${publicErrorMessage(err)}`);
  }
}

module.exports = { activeFeeConfig, feeApplies, attachSendFee, planFee, feePreviewLines, recordSendFee, FEE_ASSETS };
