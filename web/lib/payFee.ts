/**
 * The person-to-person fee on a site payment (/api/pay/execute, quoted for
 * the page by /api/pay/fee).
 *
 * Only with FEES_ENABLED, for ETH, FLZ or tUSD from a smart-account wallet:
 * the payment and the fee go in one all-or-nothing UserOp (executeGatorCall
 * calls). An older plain wallet cannot do that and pays no fee, as in chat.
 *
 * The fee goes on top when the spendable balance (after Savings and, for ETH,
 * the gas reserve) covers both; otherwise it comes out of the amount, and the
 * payee gets the rest: a $5 link paid with exactly $5 sends $4.98. The payer
 * sees the fee and what the payee gets before confirming; the payee is told
 * only what arrived. Below the fee, or an amount no bigger than it, refused.
 *
 * Never more than the page showed: the route quotes again, and a fee higher
 * than the one the payer saw, or a balance that has moved the fee between on
 * top and out of the amount, is refused with the new figures to review.
 *
 * Ledger: pending before the send (nothing is sent without it), charged when
 * the payment lands, waived when it is not sent or reverts, left pending with
 * an unknown outcome for the reconciler, which settles it with the transfer.
 */

import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activeFeeConfig, openFee, quoteP2pFee, settleFee, waiveFee, walletGasPaidWei, type FeeQuote } from './feeQuote.ts';
import { planAmounts, type FeeConfig } from './fees.ts';
import { topupConfig } from './gasTopup.ts';
import { gatorAddresses } from './gatorAccount.ts';
import { symbolLabel } from './listedTokens.ts';
import { loadReserveRows } from './reserveStore.ts';
import { availableBase } from './reservesMath.ts';

const FEE_ASSETS = new Set(['ETH', 'FLZ', 'TUSD']);

export const PAY_FEE_COPY = Object.freeze({
  unavailable: 'Could not work out the fee right now, so nothing was sent. Try again shortly.',
  settings: 'Payments are paused for a moment, so nothing was sent. Try again shortly.',
  record: 'Could not record the fee, so nothing was sent. Try again shortly.',
});

export type PayFee = {
  units: bigint;
  treasury: string;
  quote: FeeQuote;
  cfg: FeeConfig;
};

/** How a payment and its fee leave the wallet: what the payee gets, and whether the fee came out of the amount. */
export type PayPlan = { sendUnits: bigint; feeFromAmount: boolean };

/**
 * Plan the payment against what the wallet can spend. Not enough for the
 * payment itself plans it with the fee on top, so the usual balance checks
 * refuse it with their own message.
 */
export function planPayFee(fee: PayFee, amountUnits: bigint, spendableUnits: bigint, asset: string): { ok: true; plan: PayPlan } | { ok: false; error: string } {
  const planned = planAmounts({ amountUnits, feeUnits: fee.units, balanceUnits: spendableUnits });
  if (planned.ok) return { ok: true, plan: { sendUnits: planned.sendUnits, feeFromAmount: planned.feeFromAmount } };
  if (planned.reason === 'below_fee') return { ok: false, error: `Your balance is below the ${fee.quote.feeText} fee, so nothing was sent.` };
  if (planned.reason === 'amount_below_fee') {
    return { ok: false, error: `The amount has to be more than the ${fee.quote.feeText} fee (${ethers.formatUnits(fee.units, fee.quote.decimals)} ${symbolLabel(asset)}).` };
  }
  return { ok: true, plan: { sendUnits: amountUnits, feeFromAmount: false } };
}

/** What the page shows: the fee, what the payee gets, and what leaves the wallet, in the payment's asset. */
export function feeView(fee: PayFee, plan: PayPlan, asset: string) {
  const d = fee.quote.decimals;
  return {
    feeUnits: fee.units.toString(),
    feeText: fee.quote.feeText,
    feeHuman: ethers.formatUnits(fee.units, d),
    sendHuman: ethers.formatUnits(plan.sendUnits, d),
    totalHuman: ethers.formatUnits(plan.sendUnits + fee.units, d),
    feeFromAmount: plan.feeFromAmount,
    label: symbolLabel(asset),
  };
}

/**
 * The plan the page showed still holds: the same fee mode. Otherwise the
 * payer would pay more, or the payee get less, than was shown.
 */
export function planStillShown(fee: PayFee, plan: PayPlan, shownFeeFromAmount: unknown, asset: string): { ok: true } | { ok: false; status: number; error: string; fee: ReturnType<typeof feeView> } {
  // Only an explicit answer counts: a payment that does not say which the page showed is refused.
  const shown = shownFeeFromAmount === true || shownFeeFromAmount === 'true' ? true : shownFeeFromAmount === false || shownFeeFromAmount === 'false' ? false : null;
  if (shown === plan.feeFromAmount) return { ok: true };
  const view = feeView(fee, plan, asset);
  return {
    ok: false,
    status: 409,
    error: plan.feeFromAmount
      ? `Your balance changed: the ${view.feeText} fee now comes out of the amount, so they get ${view.sendHuman} ${view.label}. Check and pay again.`
      : `Your balance changed: the ${view.feeText} fee now goes on top, ${view.totalHuman} ${view.label} in all. Check and pay again.`,
    fee: view,
  };
}

/**
 * The fee for this payment, or null when none applies (fees off, an older
 * plain wallet, an asset with no fee). With shownFeeUnits (what the page
 * showed), a higher fresh fee is refused.
 */
export async function sitePayFee(p: {
  supabase: SupabaseClient;
  provider: ethers.Provider;
  viaGator: boolean;
  asset: string;
  amountUnits: bigint;
  flzPool: { flz: string; pair: string };
  shownFeeUnits?: unknown;
  env?: Record<string, string | undefined>;
}): Promise<{ ok: true; fee: PayFee | null } | { ok: false; status: number; error: string; higherFee?: PayFee }> {
  let cfg: FeeConfig | null;
  try {
    cfg = activeFeeConfig(p.env ?? process.env);
  } catch (err) {
    console.warn(`[fees] settings refused: ${err instanceof Error ? err.message : 'unreadable'}`);
    return { ok: false, status: 503, error: PAY_FEE_COPY.settings };
  }
  if (!cfg || !cfg.treasury || !p.viaGator || !FEE_ASSETS.has(p.asset)) return { ok: true, fee: null };
  let quote: FeeQuote;
  try {
    quote = await quoteP2pFee({ supabase: p.supabase, provider: p.provider, asset: p.asset, amountUnits: p.amountUnits, cfg, flzPool: p.flzPool });
  } catch (err) {
    console.warn(`[fees] quote failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
    return { ok: false, status: 503, error: PAY_FEE_COPY.unavailable };
  }
  const fee: PayFee = { units: BigInt(quote.feeUnits), treasury: cfg.treasury, quote, cfg };
  if (p.shownFeeUnits !== undefined) {
    let shown: bigint | null = null;
    try {
      shown = BigInt(String(p.shownFeeUnits));
    } catch {
      shown = null;
    }
    if (shown === null || shown < 0n || fee.units > shown) {
      const feeHuman = ethers.formatUnits(fee.units, quote.decimals);
      return { ok: false, status: 409, error: `The fee is now ${quote.feeText} (${feeHuman} ${symbolLabel(p.asset)}). Check and pay again.`, higherFee: fee };
    }
  }
  return { ok: true, fee };
}

/**
 * What the wallet can spend of an asset: what it holds, less Savings, less the
 * gas reserve (ETH only). null when Savings cannot be read: the caller sends
 * nothing.
 */
export async function spendableUnits(supabase: SupabaseClient, accountId: string, asset: string, holding: bigint, gas: bigint): Promise<bigint | null> {
  const loaded = await loadReserveRows(supabase, accountId);
  if (!loaded.ok) return null;
  const row = loaded.rows.find((r) => r.asset === asset);
  return availableBase(holding, row ? BigInt(row.amount) : 0n, gas);
}

/** The fee's own call in the batch: ETH by value, a token by transfer. */
export function feeCall(fee: PayFee, tokenAddress: string | null) {
  if (!tokenAddress) return { target: fee.treasury, value: fee.units, data: '0x' };
  const erc20 = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  return { target: tokenAddress, value: 0n, data: erc20.encodeFunctionData('transfer', [fee.treasury, fee.units]) };
}

/** Pending before the send. Throws when it cannot be written: the caller then sends nothing. */
export async function openPayFee(supabase: SupabaseClient, fee: PayFee, transferId: string, accountId: string) {
  await openFee({ supabase, sourceKind: 'transfer', sourceId: transferId, accountId, quote: fee.quote });
}

/** Landed: charged, with the gas Flizy paid. Never throws. */
export async function settlePayFee(supabase: SupabaseClient, fee: PayFee, transferId: string, txHash: string, receipt: ethers.TransactionReceipt | null, gator: string) {
  try {
    let toppedUp = false;
    try {
      toppedUp = topupConfig().enabled;
    } catch {
      toppedUp = false;
    }
    const gasPaid = walletGasPaidWei({ toppedUp, receipt, entryPoint: gatorAddresses().entryPointV07, gator });
    await settleFee({ supabase, sourceKind: 'transfer', sourceId: transferId, txHash, gasPaid, cfg: fee.cfg });
  } catch (err) {
    console.error(`[fees] a charged fee was not settled in the ledger: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
  }
}

/** Not sent, or reverted: waived. Never throws. */
export async function waivePayFee(supabase: SupabaseClient, transferId: string, reason: string) {
  try {
    await waiveFee({ supabase, sourceKind: 'transfer', sourceId: transferId, reason });
  } catch (err) {
    console.error(`[fees] a fee that was not charged is still pending: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
  }
}
