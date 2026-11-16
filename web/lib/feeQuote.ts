/**
 * A payment's fee on the site: quoted from the chain and the fee ledger, kept
 * as a pending ledger row while the payment is sent, then charged or waived.
 *
 * Mirror of lib/feeQuote.js (web/ cannot import root lib/), which documents
 * the inputs: ETH at FEE_ETH_USD_RATE, tUSD at $1, FLZ from the Flizy FLZ/WETH
 * pool at that rate, and any other listed token from its own ETH pool; FEE_PAYMENT_GAS at the current max fee per gas; what
 * Flizy absorbed since 00:00 UTC. The rules are web/lib/fees.ts.
 *
 * The pool addresses come from the caller (dexServer getDexAddresses), so this
 * module loads nothing that reads the environment beyond the fee settings.
 */

import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as fees from './fees.ts';
import { listedBySymbol } from './listedTokens.ts';

const LEDGER = 'fee_ledger';
/** Gas a UserOp carrying a payment and its fee uses (scripts/fees-fork-check.js), rounded up. */
export const FEE_PAYMENT_GAS = 300_000n;

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];

export type FeeQuote = {
  kind: 'p2p' | 'merchant';
  asset: string;
  decimals: number;
  feeUnits: string;
  feeMicro: string;
  /** The person-to-person tier and gas estimate; null on a merchant fee. */
  tierMicro: string | null;
  gasEstMicro: string | null;
  absorbMicro: string;
  gasOverTier: boolean;
  priceMicro: string;
  priceSource: string;
  pricedAt: string;
  feeText: string;
};

type Log = { warn: (line: string) => void };

/** The fee settings when fees are on, or null when off. On, malformed settings throw. */
export function activeFeeConfig(env: Record<string, string | undefined> = process.env): fees.FeeConfig | null {
  if (String(env.FEES_ENABLED || '').trim().toLowerCase() !== 'true') return null;
  return fees.feeConfig(env);
}

/** Decimals of the assets a fee can be charged in: ETH, FLZ and the listed tokens. */
export function feeDecimals(asset: string): number {
  if (asset === 'ETH' || asset === 'FLZ') return 18;
  const listed = listedBySymbol(asset);
  if (listed) return Number(listed.decimals);
  throw new Error(`no fee is defined for ${asset}`);
}

/** micro-USD per whole token from its ETH pool's reserves, at the configured ETH rate. */
async function poolPriceMicro(provider: ethers.Provider, token: string, pairAddress: string, decimals: number, ethUsd: bigint, symbol: string): Promise<bigint> {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [[r0, r1], t0] = await Promise.all([pair.getReserves() as Promise<[bigint, bigint, number]>, pair.token0() as Promise<string>]);
  const tokenIs0 = ethers.getAddress(t0) === ethers.getAddress(token);
  const reserveToken = BigInt(tokenIs0 ? r0 : r1);
  const reserveWeth = BigInt(tokenIs0 ? r1 : r0);
  if (reserveToken === 0n || reserveWeth === 0n) throw new Error(`the ${symbol} pool is empty`);
  // USD per whole token = (WETH per token, decimals evened out) x USD per ETH.
  const priceMicro = (reserveWeth * ethUsd * 10n ** BigInt(decimals)) / (reserveToken * 10n ** 18n);
  if (priceMicro <= 0n) throw new Error(`the ${symbol} price rounds to zero`);
  return priceMicro;
}

/** The USD price of one whole token, in micro-USD, and its source. Throws when it cannot be read. */
export async function priceMicroFor(
  asset: string,
  p: { provider: ethers.Provider; cfg: fees.FeeConfig; flzPool: { flz: string; pair: string } }
): Promise<{ priceMicro: bigint; source: string }> {
  if (asset === 'ETH') return { priceMicro: p.cfg.ethUsd, source: 'FEE_ETH_USD_RATE' };
  if (asset === 'TUSD') return { priceMicro: fees.MICRO, source: 'tUSD at $1' };
  if (asset === 'FLZ') {
    return { priceMicro: await poolPriceMicro(p.provider, p.flzPool.flz, p.flzPool.pair, 18, p.cfg.ethUsd, 'FLZ'), source: 'Flizy FLZ/WETH pool' };
  }
  const listed = listedBySymbol(asset);
  if (listed && listed.pair) {
    return {
      priceMicro: await poolPriceMicro(p.provider, listed.address, listed.pair, Number(listed.decimals), p.cfg.ethUsd, listed.symbol),
      source: `Flizy ${listed.symbol}/WETH pool`,
    };
  }
  throw new Error(`no fee price for ${asset}`);
}

function utcDayStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** micro-USD of gas Flizy absorbed today across all accounts, not counting waived fees. Throws when it cannot be read. */
export async function absorbedTodayMicro(supabase: SupabaseClient, now: number = Date.now()): Promise<bigint> {
  const { data, error } = await supabase
    .from(LEDGER)
    .select('absorbed_usd_micro')
    .gte('created_at', utcDayStart(now))
    .gt('absorbed_usd_micro', 0)
    .not('state', 'eq', 'waived');
  if (error) throw new Error(error.message);
  return ((data || []) as Array<{ absorbed_usd_micro: string | number }>).reduce((sum, r) => sum + BigInt(r.absorbed_usd_micro), 0n);
}

/** The person-to-person fee for sending amountUnits of an asset. Same result as lib/feeQuote.js quoteP2pFee. */
export async function quoteP2pFee(p: {
  supabase: SupabaseClient;
  provider: ethers.Provider;
  asset: string;
  amountUnits: bigint;
  cfg: fees.FeeConfig;
  flzPool: { flz: string; pair: string };
  now?: number;
  log?: Log;
}): Promise<FeeQuote> {
  const now = p.now ?? Date.now();
  const log = p.log ?? console;
  const decimals = feeDecimals(p.asset);
  const { priceMicro, source } = await priceMicroFor(p.asset, { provider: p.provider, cfg: p.cfg, flzPool: p.flzPool });
  const amountMicro = fees.unitsToUsdMicro(BigInt(p.amountUnits), priceMicro, decimals);
  const tierMicro = fees.p2pTierMicro(amountMicro, p.cfg);
  const feeData = await p.provider.getFeeData();
  const maxFee = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const gasEstMicro = fees.gasWeiToMicro(FEE_PAYMENT_GAS * BigInt(maxFee), p.cfg);
  const absorbed = await absorbedTodayMicro(p.supabase, now);
  const decided = fees.busyNetworkFee({ tierMicro, gasMicro: gasEstMicro, absorbedTodayMicro: absorbed }, p.cfg);
  if (decided.gasOverTier) {
    log.warn(`[fees] gas estimate ${fees.centsText(gasEstMicro)} is above the ${fees.centsText(tierMicro)} tier fee: charging ${fees.centsText(decided.feeMicro)}`);
  }
  const feeUnits = fees.usdToUnits(decided.feeMicro, priceMicro, decimals);
  return {
    kind: 'p2p',
    asset: p.asset,
    decimals,
    feeUnits: feeUnits.toString(),
    feeMicro: decided.feeMicro.toString(),
    tierMicro: tierMicro.toString(),
    gasEstMicro: gasEstMicro.toString(),
    absorbMicro: decided.absorbMicro.toString(),
    gasOverTier: decided.gasOverTier,
    priceMicro: priceMicro.toString(),
    priceSource: source,
    pricedAt: new Date(now).toISOString(),
    feeText: fees.centsText(decided.feeMicro),
  };
}

/**
 * The merchant fee on a payment of amountUnits to a business: FEE_MERCHANT_BPS
 * of it (0.5% by default), rounded up, and at least FEE_MERCHANT_MIN_USD
 * ($0.01), out of what the business receives. null only when both are 0. Same
 * result as lib/feeQuote.js quoteMerchantFee.
 */
export async function quoteMerchantFee(p: {
  provider: ethers.Provider;
  asset: string;
  amountUnits: bigint;
  cfg: fees.FeeConfig;
  flzPool: { flz: string; pair: string };
  now?: number;
}): Promise<FeeQuote | null> {
  const decimals = feeDecimals(p.asset);
  const { priceMicro, source } = await priceMicroFor(p.asset, { provider: p.provider, cfg: p.cfg, flzPool: p.flzPool });
  const byRate = fees.merchantFeeUnits(BigInt(p.amountUnits), p.cfg);
  const least = p.cfg.merchantMin > 0n ? fees.usdToUnits(p.cfg.merchantMin, priceMicro, decimals) : 0n;
  const feeUnits = byRate > least ? byRate : least;
  if (feeUnits === 0n) return null;
  const feeMicro = fees.unitsToUsdMicro(feeUnits, priceMicro, decimals);
  return {
    kind: 'merchant',
    asset: p.asset,
    decimals,
    feeUnits: feeUnits.toString(),
    feeMicro: feeMicro.toString(),
    tierMicro: null,
    gasEstMicro: null,
    absorbMicro: '0',
    gasOverTier: false,
    priceMicro: priceMicro.toString(),
    priceSource: source,
    pricedAt: new Date(p.now ?? Date.now()).toISOString(),
    feeText: fees.centsText(feeMicro),
  };
}

/**
 * The gas Flizy paid for a payment the wallet sent: its actualGasCost when the
 * gas top-up funded the UserOp, otherwise 0 (the wallet paid). null when the
 * receipt does not show it.
 */
export function walletGasPaidWei(p: { toppedUp: boolean; receipt: ethers.TransactionReceipt | null; entryPoint: string; gator: string }): bigint | null {
  if (!p.receipt) return null;
  if (!p.toppedUp) return 0n;
  const ep = ethers.getAddress(p.entryPoint);
  const who = ethers.getAddress(p.gator);
  const iface = new ethers.Interface([
    'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  ]);
  for (const log of p.receipt.logs || []) {
    if (!log || !log.address || ethers.getAddress(log.address) !== ep) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: Array.from(log.topics), data: log.data });
    } catch {
      continue;
    }
    if (parsed && ethers.getAddress(parsed.args.sender) === who) return BigInt(parsed.args.actualGasCost);
  }
  return null;
}

function quoteFields(quote: FeeQuote) {
  return {
    kind: quote.kind,
    asset: quote.asset,
    fee_units: String(quote.feeUnits),
    fee_usd_micro: String(quote.feeMicro),
    tier_usd_micro: quote.tierMicro == null ? null : String(quote.tierMicro),
    gas_est_usd_micro: quote.gasEstMicro == null ? null : String(quote.gasEstMicro),
    absorbed_usd_micro: String(quote.absorbMicro || '0'),
    gas_over_tier: Boolean(quote.gasOverTier),
    price_usd_micro: String(quote.priceMicro),
    price_source: quote.priceSource,
    priced_at: quote.pricedAt,
  };
}

/** A fee on record as pending before its payment is sent. Once per source and kind. Throws when it cannot be written. */
export async function openFee(p: { supabase: SupabaseClient; sourceKind: 'transfer'; sourceId: string; accountId: string; quote: FeeQuote }): Promise<void> {
  const { error } = await p.supabase
    .from(LEDGER)
    .upsert(
      { source_kind: p.sourceKind, source_id: p.sourceId, account_id: p.accountId, state: 'pending', ...quoteFields(p.quote) },
      { onConflict: 'source_kind,source_id,kind', ignoreDuplicates: true }
    );
  if (error) throw new Error(error.message);
}

/*
 * A transfer has one fee, the person-to-person fee or the merchant fee: settle
 * and waive act on it whatever its kind, as lib/feeQuote.js does.
 */

/** A pending fee that landed: charged, with its hash and the gas Flizy paid. Returns whether it moved. Throws on a write error. */
export async function settleFee(p: {
  supabase: SupabaseClient;
  sourceKind: 'transfer';
  sourceId: string;
  txHash: string | null;
  gasPaid: bigint | null;
  cfg: fees.FeeConfig;
}): Promise<boolean> {
  const { data: rows, error: readErr } = await p.supabase
    .from(LEDGER)
    .select('id, fee_usd_micro')
    .eq('source_kind', p.sourceKind)
    .eq('source_id', p.sourceId)
    .eq('state', 'pending');
  if (readErr) throw new Error(readErr.message);
  const row = ((rows || []) as Array<{ id: string; fee_usd_micro: string | number }>)[0];
  if (!row) return false;
  const gasUsd = p.gasPaid == null ? null : fees.gasWeiToMicro(p.gasPaid, p.cfg);
  const { data, error } = await p.supabase
    .from(LEDGER)
    .update({
      state: 'charged',
      settled_at: new Date().toISOString(),
      tx_hash: p.txHash ? String(p.txHash).toLowerCase() : null,
      gas_paid_wei: p.gasPaid == null ? null : p.gasPaid.toString(),
      gas_paid_usd_micro: gasUsd == null ? null : gasUsd.toString(),
      net_usd_micro: gasUsd == null ? null : (BigInt(row.fee_usd_micro) - gasUsd).toString(),
    })
    .eq('id', row.id)
    .eq('state', 'pending')
    .select('id');
  if (error) throw new Error(error.message);
  return Boolean(data && data.length);
}

/** A pending fee that was not charged: waived, with why. Returns whether it moved. Throws on a write error. */
export async function waiveFee(p: { supabase: SupabaseClient; sourceKind: 'transfer'; sourceId: string; reason: string }): Promise<boolean> {
  const { data, error } = await p.supabase
    .from(LEDGER)
    .update({ state: 'waived', settled_at: new Date().toISOString(), waive_reason: String(p.reason || 'not charged').slice(0, 200) })
    .eq('source_kind', p.sourceKind)
    .eq('source_id', p.sourceId)
    .eq('state', 'pending')
    .select('id');
  if (error) throw new Error(error.message);
  return Boolean(data && data.length);
}
