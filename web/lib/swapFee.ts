/**
 * The swap fee in the fee ledger, for swaps made on the site.
 *
 * Mirror of lib/swapFee.js (web/ cannot import root lib/), which documents the
 * rules: the fee router's FeeTaken(payer, token, amount) read from a landed
 * swap's receipt, recorded as charged, kind 'swap', against the swap's
 * transfers row; ETH, FLZ and listed tokens only; gas counted as Flizy's only
 * when the gas top-up funded a smart account's swap. Never throws.
 */

import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as fees from './fees.ts';
import { feeDecimals, priceMicroFor, walletGasPaidWei } from './feeQuote.ts';
import { topupConfig } from './gasTopup.ts';
import { gatorAddresses } from './gatorAccount.ts';
import { listedByAddress } from './listedTokens.ts';

const FEE_TAKEN = new ethers.Interface(['event FeeTaken(address indexed payer, address token, uint256 amount)']);

type FeeTaken = { payer: string; token: string; amount: bigint };

/** The FeeTaken events a receipt carries from the fee router, optionally only for one payer. */
export function feeTakenFrom(receipt: ethers.TransactionReceipt | null, feeRouter: string, payer: string | null = null): FeeTaken[] {
  const router = ethers.getAddress(feeRouter);
  const who = payer ? ethers.getAddress(payer) : null;
  const out: FeeTaken[] = [];
  for (const log of receipt?.logs || []) {
    if (!log || !log.address || ethers.getAddress(log.address) !== router) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = FEE_TAKEN.parseLog({ topics: Array.from(log.topics), data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    const entry = { payer: ethers.getAddress(parsed.args.payer), token: ethers.getAddress(parsed.args.token), amount: BigInt(parsed.args.amount) };
    if (who && entry.payer !== who) continue;
    out.push(entry);
  }
  return out;
}

/** The ledger symbol of a fee token: ETH for the zero address, FLZ, a listed token, or null. */
export function feeAssetOf(token: string, flz: string): string | null {
  if (token === ethers.ZeroAddress) return 'ETH';
  if (ethers.getAddress(flz) === token) return 'FLZ';
  return listedByAddress(token)?.symbol ?? null;
}

/** Record a landed site swap's fee. Returns 'recorded', 'duplicate' or why nothing was recorded. Never throws. */
export async function recordSwapFee(p: {
  supabase: SupabaseClient;
  provider: ethers.Provider;
  receipt: ethers.TransactionReceipt | null;
  transferId: string | null | undefined;
  accountId: string;
  /** The wallet that called the router: the smart account, or a plain wallet. */
  payer: string;
  /** The smart account, when it swapped; null for a plain wallet (which paid its own gas). */
  gator: string | null;
  dex: { feeRouter: string; flz: string; pair: string };
  env?: Record<string, string | undefined>;
}): Promise<string> {
  try {
    if (!p.receipt || p.receipt.status !== 1 || !p.transferId) return 'no swap';
    const [taken] = feeTakenFrom(p.receipt, p.dex.feeRouter, p.payer);
    if (!taken || taken.amount === 0n) return 'no fee';
    const asset = feeAssetOf(taken.token, p.dex.flz);
    if (!asset) return 'unlisted token';
    const env = p.env ?? process.env;
    const cfg = fees.feeConfig(env);
    const decimals = feeDecimals(asset);
    const { priceMicro, source } = await priceMicroFor(asset, { provider: p.provider, cfg, flzPool: { flz: p.dex.flz, pair: p.dex.pair } });
    const feeMicro = fees.unitsToUsdMicro(taken.amount, priceMicro, decimals);
    let toppedUp = false;
    try {
      toppedUp = topupConfig(env).enabled;
    } catch {
      toppedUp = false;
    }
    const gasPaid = p.gator ? walletGasPaidWei({ toppedUp, receipt: p.receipt, entryPoint: gatorAddresses().entryPointV07, gator: p.gator }) : 0n;
    const gasUsd = gasPaid == null ? null : fees.gasWeiToMicro(gasPaid, cfg);
    const now = new Date().toISOString();
    const { data, error } = await p.supabase
      .from('fee_ledger')
      .upsert(
        {
          source_kind: 'transfer',
          source_id: p.transferId,
          account_id: p.accountId,
          tx_hash: String(p.receipt.hash).toLowerCase(),
          kind: 'swap',
          asset,
          fee_units: taken.amount.toString(),
          fee_usd_micro: feeMicro.toString(),
          tier_usd_micro: null,
          gas_est_usd_micro: null,
          absorbed_usd_micro: '0',
          gas_over_tier: false,
          price_usd_micro: priceMicro.toString(),
          price_source: source,
          priced_at: now,
          gas_paid_wei: gasPaid == null ? null : gasPaid.toString(),
          gas_paid_usd_micro: gasUsd == null ? null : gasUsd.toString(),
          net_usd_micro: gasUsd == null ? null : (feeMicro - gasUsd).toString(),
          // Recorded once it has landed: charged from the start.
          state: 'charged',
          settled_at: now,
        },
        { onConflict: 'source_kind,source_id,kind', ignoreDuplicates: true }
      )
      .select('id');
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return row && row.id ? 'recorded' : 'duplicate';
  } catch (err) {
    console.error(`[fees] a swap fee was not recorded in the ledger: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
    return 'failed';
  }
}
