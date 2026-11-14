/**
 * Payment fees: the rules that need no network.
 *
 * Mirror of lib/fees.js (web/ cannot import root lib/), which documents the
 * rules: the FEES_ENABLED switch, the person-to-person tiers, the merchant
 * rate, the busy-network rule and its daily absorption cap, the fixed testnet
 * ETH rate, rounding, and the fee treasury. test/feesEngine.test.js runs both
 * on the same inputs.
 *
 * Money is micro-USD (USD x 1,000,000) and raw asset units, as bigint.
 */

import { ethers } from 'ethers';

export const MICRO = 1_000_000n;

export const DEFAULTS = Object.freeze({
  FEE_P2P_BASE_USD: '0.02',
  FEE_P2P_STEP_USD: '0.01',
  FEE_P2P_STEP_SIZE_USD: '100',
  FEE_MERCHANT_BPS: '100',
  FEE_GAS_MARGIN_BPS: '2000',
  FEE_ABSORB_MAX_MULTIPLE: '2',
  FEE_ABSORB_DAILY_CAP_USD: '5',
  FEE_ETH_USD_RATE: '3000',
});

type Key = keyof typeof DEFAULTS;

export type FeeConfig = Readonly<{
  enabled: boolean;
  treasury: string | null;
  p2pBase: bigint;
  p2pStep: bigint;
  p2pStepSize: bigint;
  merchantBps: number;
  gasMarginBps: number;
  absorbMaxMultiple: number;
  absorbDailyCap: bigint;
  ethUsd: bigint;
}>;

/** "0.02" as micro-USD. Up to six decimals, never negative. Throws on anything else. */
export function parseUsdMicro(raw: unknown, name = 'amount'): bigint {
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`${name} must be a USD amount with at most 6 decimals`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, '0'));
}

function parseWhole(raw: unknown, name: string, { min, max }: { min: number; max: number }): number {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

/** The fee settings, read from the environment. See lib/fees.js. */
export function feeConfig(env: Record<string, string | undefined> = process.env): FeeConfig {
  const get = (key: Key): string => {
    const v = env[key];
    return v === undefined || v === null || String(v).trim() === '' ? DEFAULTS[key] : String(v);
  };
  const enabled = String(env.FEES_ENABLED || '').trim().toLowerCase() === 'true';
  const rawTreasury = String(env.FEE_TREASURY_ADDRESS || '').trim();
  let treasury: string | null = null;
  if (rawTreasury) {
    if (!ethers.isAddress(rawTreasury)) throw new Error('FEE_TREASURY_ADDRESS is not an address');
    treasury = ethers.getAddress(rawTreasury);
    if (treasury === ethers.ZeroAddress) throw new Error('FEE_TREASURY_ADDRESS is the zero address');
  }
  if (enabled && !treasury) throw new Error('FEES_ENABLED needs FEE_TREASURY_ADDRESS');
  const stepSize = parseUsdMicro(get('FEE_P2P_STEP_SIZE_USD'), 'FEE_P2P_STEP_SIZE_USD');
  if (stepSize === 0n) throw new Error('FEE_P2P_STEP_SIZE_USD must be above zero');
  const ethUsd = parseUsdMicro(get('FEE_ETH_USD_RATE'), 'FEE_ETH_USD_RATE');
  if (ethUsd === 0n) throw new Error('FEE_ETH_USD_RATE must be above zero');
  return Object.freeze({
    enabled,
    treasury,
    p2pBase: parseUsdMicro(get('FEE_P2P_BASE_USD'), 'FEE_P2P_BASE_USD'),
    p2pStep: parseUsdMicro(get('FEE_P2P_STEP_USD'), 'FEE_P2P_STEP_USD'),
    p2pStepSize: stepSize,
    merchantBps: parseWhole(get('FEE_MERCHANT_BPS'), 'FEE_MERCHANT_BPS', { min: 0, max: 1000 }),
    gasMarginBps: parseWhole(get('FEE_GAS_MARGIN_BPS'), 'FEE_GAS_MARGIN_BPS', { min: 0, max: 10000 }),
    absorbMaxMultiple: parseWhole(get('FEE_ABSORB_MAX_MULTIPLE'), 'FEE_ABSORB_MAX_MULTIPLE', { min: 1, max: 10 }),
    absorbDailyCap: parseUsdMicro(get('FEE_ABSORB_DAILY_CAP_USD'), 'FEE_ABSORB_DAILY_CAP_USD'),
    ethUsd,
  });
}

/** The person-to-person fee for a payment worth amountMicro. */
export function p2pTierMicro(amountMicro: bigint, cfg: FeeConfig): bigint {
  const amount = BigInt(amountMicro);
  if (amount < 0n) throw new Error('amount must not be negative');
  const above = amount > cfg.p2pStepSize ? amount - cfg.p2pStepSize : 0n;
  const steps = (above + cfg.p2pStepSize - 1n) / cfg.p2pStepSize;
  return cfg.p2pBase + steps * cfg.p2pStep;
}

/** The merchant fee on an amount in raw units, rounded up to one unit. */
export function merchantFeeUnits(amountUnits: bigint, cfg: FeeConfig): bigint {
  const amount = BigInt(amountUnits);
  if (amount < 0n) throw new Error('amount must not be negative');
  return (amount * BigInt(cfg.merchantBps) + 9999n) / 10000n;
}

/** micro-USD to raw units of an asset priced at priceMicro per whole token, rounded up. */
export function usdToUnits(micro: bigint, priceMicro: bigint, decimals: number): bigint {
  const price = BigInt(priceMicro);
  if (price <= 0n) throw new Error('price must be above zero');
  const scale = 10n ** BigInt(decimals);
  return (BigInt(micro) * scale + price - 1n) / price;
}

/** Raw units to micro-USD, rounded down. */
export function unitsToUsdMicro(units: bigint, priceMicro: bigint, decimals: number): bigint {
  return (BigInt(units) * BigInt(priceMicro)) / 10n ** BigInt(decimals);
}

/** Gas in wei to micro-USD at the configured ETH rate, rounded up. */
export function gasWeiToMicro(gasWei: bigint, cfg: FeeConfig): bigint {
  return (BigInt(gasWei) * cfg.ethUsd + 10n ** 18n - 1n) / 10n ** 18n;
}

/** The fee to charge when gas may be above the tier fee. See lib/fees.js. */
export function busyNetworkFee(
  p: { tierMicro: bigint; gasMicro: bigint; absorbedTodayMicro?: bigint },
  cfg: FeeConfig
): { feeMicro: bigint; absorbMicro: bigint; gasOverTier: boolean } {
  const tier = BigInt(p.tierMicro);
  const gas = BigInt(p.gasMicro);
  const withMargin = gas + (gas * BigInt(cfg.gasMarginBps)) / 10000n;
  const gasOverTier = gas > tier;
  if (withMargin <= tier) return { feeMicro: tier, absorbMicro: 0n, gasOverTier };
  const absorb = gas > tier ? gas - tier : 0n;
  const small = withMargin <= tier * BigInt(cfg.absorbMaxMultiple);
  if (small && BigInt(p.absorbedTodayMicro ?? 0n) + absorb <= cfg.absorbDailyCap) {
    return { feeMicro: tier, absorbMicro: absorb, gasOverTier };
  }
  return { feeMicro: withMargin, absorbMicro: 0n, gasOverTier };
}

export type PlannedAmounts =
  | { ok: true; sendUnits: bigint; feeUnits: bigint; totalUnits: bigint; feeFromAmount: boolean }
  | { ok: false; reason: 'below_fee' | 'amount_below_fee' | 'insufficient' };

/** What leaves the wallet, from the amount asked for, the fee and the balance. See lib/fees.js. */
export function planAmounts(p: { amountUnits: bigint; feeUnits: bigint; balanceUnits: bigint; sendAll?: boolean }): PlannedAmounts {
  const fee = BigInt(p.feeUnits);
  const balance = BigInt(p.balanceUnits);
  if (balance <= fee) return { ok: false, reason: 'below_fee' };
  if (p.sendAll) return { ok: true, sendUnits: balance - fee, feeUnits: fee, totalUnits: balance, feeFromAmount: true };
  const amount = BigInt(p.amountUnits);
  if (amount <= 0n) return { ok: false, reason: 'insufficient' };
  if (balance >= amount + fee) return { ok: true, sendUnits: amount, feeUnits: fee, totalUnits: amount + fee, feeFromAmount: false };
  if (balance < amount) return { ok: false, reason: 'insufficient' };
  if (amount <= fee) return { ok: false, reason: 'amount_below_fee' };
  return { ok: true, sendUnits: amount - fee, feeUnits: fee, totalUnits: amount, feeFromAmount: true };
}

/** micro-USD shown rounded to the cent, half up: "$0.02". */
export function centsText(micro: bigint): string {
  const cents = (BigInt(micro) + 5_000n) / 10_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
