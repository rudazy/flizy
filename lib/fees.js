/**
 * Payment fees: the rules that need no network.
 *
 * Mirror of web/lib/fees.ts (web/ cannot import root lib/);
 * test/feesEngine.test.js runs both on the same inputs.
 *
 * - Switch: FEES_ENABLED, off unless exactly "true". Off means no fee anywhere.
 * - Person to person: FEE_P2P_BASE_USD for an amount up to FEE_P2P_STEP_SIZE_USD,
 *   plus FEE_P2P_STEP_USD for every started step above it ($0.02, $0.01, $100:
 *   $150 pays $0.03). Paid by the sender, on top, in the asset sent.
 * - Merchant: FEE_MERCHANT_BPS of the amount (100 = 1%), taken from what the
 *   merchant receives.
 * - Busy network: the fee is the higher of the tier fee and the gas plus
 *   FEE_GAS_MARGIN_BPS. Flizy keeps the tier fee and absorbs the difference
 *   while gas plus margin is at most FEE_ABSORB_MAX_MULTIPLE times the tier
 *   fee and today's absorbed total stays within FEE_ABSORB_DAILY_CAP_USD.
 * - Prices: tUSD is $1. ETH is FEE_ETH_USD_RATE, a fixed testnet rate; a live
 *   price source replaces it before mainnet. FLZ is priced from the Flizy pool
 *   by the caller and passed in.
 * - Rounding: a fee in an asset is rounded up to the asset's smallest unit;
 *   shown rounded to the cent.
 * - Fees go to FEE_TREASURY_ADDRESS, an address only: its key is never on a server.
 *
 * Money is micro-USD (USD x 1,000,000) and raw asset units, as BigInt. No
 * floating point touches an amount.
 */

const { ethers } = require('ethers');

const MICRO = 1_000_000n;

const DEFAULTS = Object.freeze({
  FEE_P2P_BASE_USD: '0.02',
  FEE_P2P_STEP_USD: '0.01',
  FEE_P2P_STEP_SIZE_USD: '100',
  FEE_MERCHANT_BPS: '100',
  FEE_GAS_MARGIN_BPS: '2000',
  FEE_ABSORB_MAX_MULTIPLE: '2',
  FEE_ABSORB_DAILY_CAP_USD: '5',
  FEE_ETH_USD_RATE: '3000',
});

/** "0.02" as micro-USD. Up to six decimals, never negative. Throws on anything else. */
function parseUsdMicro(raw, name = 'amount') {
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`${name} must be a USD amount with at most 6 decimals`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, '0'));
}

function parseWhole(raw, name, { min, max }) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

/**
 * The fee settings, read from the environment. A setting that is present but
 * malformed throws, as does FEES_ENABLED without a treasury, so a bad
 * deployment fails at start rather than charging the wrong amount.
 * @param {Record<string, string|undefined>} [env]
 */
function feeConfig(env = process.env) {
  const get = (key) => {
    const v = env[key];
    return v === undefined || v === null || String(v).trim() === '' ? DEFAULTS[key] : String(v);
  };
  const enabled = String(env.FEES_ENABLED || '').trim().toLowerCase() === 'true';
  const rawTreasury = String(env.FEE_TREASURY_ADDRESS || '').trim();
  let treasury = null;
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

/** The person-to-person fee for a payment worth amountMicro: the base, plus a step per started step above the first. */
function p2pTierMicro(amountMicro, cfg) {
  const amount = BigInt(amountMicro);
  if (amount < 0n) throw new Error('amount must not be negative');
  const above = amount > cfg.p2pStepSize ? amount - cfg.p2pStepSize : 0n;
  const steps = (above + cfg.p2pStepSize - 1n) / cfg.p2pStepSize;
  return cfg.p2pBase + steps * cfg.p2pStep;
}

/** The merchant fee on an amount in raw units, rounded up to one unit. */
function merchantFeeUnits(amountUnits, cfg) {
  const amount = BigInt(amountUnits);
  if (amount < 0n) throw new Error('amount must not be negative');
  return (amount * BigInt(cfg.merchantBps) + 9999n) / 10000n;
}

/** micro-USD to raw units of an asset priced at priceMicro per whole token, rounded up. */
function usdToUnits(micro, priceMicro, decimals) {
  const price = BigInt(priceMicro);
  if (price <= 0n) throw new Error('price must be above zero');
  const scale = 10n ** BigInt(decimals);
  return (BigInt(micro) * scale + price - 1n) / price;
}

/** Raw units to micro-USD, rounded down: what an amount is worth, never more. */
function unitsToUsdMicro(units, priceMicro, decimals) {
  return (BigInt(units) * BigInt(priceMicro)) / 10n ** BigInt(decimals);
}

/** Gas in wei to micro-USD at the configured ETH rate, rounded up. */
function gasWeiToMicro(gasWei, cfg) {
  return (BigInt(gasWei) * cfg.ethUsd + 10n ** 18n - 1n) / 10n ** 18n;
}

/**
 * The fee to charge when gas may be above the tier fee.
 * @returns {{ feeMicro: bigint, absorbMicro: bigint, gasOverTier: boolean }}
 *   absorbMicro is the gas above the tier fee that Flizy pays; gasOverTier is
 *   every case to log.
 */
function busyNetworkFee({ tierMicro, gasMicro, absorbedTodayMicro = 0n }, cfg) {
  const tier = BigInt(tierMicro);
  const gas = BigInt(gasMicro);
  const withMargin = gas + (gas * BigInt(cfg.gasMarginBps)) / 10000n;
  const gasOverTier = gas > tier;
  if (withMargin <= tier) return { feeMicro: tier, absorbMicro: 0n, gasOverTier };
  const absorb = gas > tier ? gas - tier : 0n;
  const small = withMargin <= tier * BigInt(cfg.absorbMaxMultiple);
  if (small && BigInt(absorbedTodayMicro) + absorb <= cfg.absorbDailyCap) {
    return { feeMicro: tier, absorbMicro: absorb, gasOverTier };
  }
  return { feeMicro: withMargin, absorbMicro: 0n, gasOverTier };
}

/**
 * What leaves the wallet, from the amount asked for, the fee and the balance.
 * A fee that does not fit on top comes out of the amount; send all does that
 * on purpose. A balance below the fee is refused.
 * @returns {{ ok: true, sendUnits: bigint, feeUnits: bigint, totalUnits: bigint, feeFromAmount: boolean }
 *   | { ok: false, reason: 'below_fee' | 'amount_below_fee' | 'insufficient' }}
 */
function planAmounts({ amountUnits, feeUnits, balanceUnits, sendAll = false }) {
  const fee = BigInt(feeUnits);
  const balance = BigInt(balanceUnits);
  if (balance <= fee) return { ok: false, reason: 'below_fee' };
  if (sendAll) return { ok: true, sendUnits: balance - fee, feeUnits: fee, totalUnits: balance, feeFromAmount: true };
  const amount = BigInt(amountUnits);
  if (amount <= 0n) return { ok: false, reason: 'insufficient' };
  if (balance >= amount + fee) return { ok: true, sendUnits: amount, feeUnits: fee, totalUnits: amount + fee, feeFromAmount: false };
  if (balance < amount) return { ok: false, reason: 'insufficient' };
  if (amount <= fee) return { ok: false, reason: 'amount_below_fee' };
  return { ok: true, sendUnits: amount - fee, feeUnits: fee, totalUnits: amount, feeFromAmount: true };
}

/** micro-USD shown rounded to the cent, half up: "$0.02". */
function centsText(micro) {
  const cents = (BigInt(micro) + 5_000n) / 10_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

module.exports = {
  MICRO,
  DEFAULTS,
  parseUsdMicro,
  feeConfig,
  p2pTierMicro,
  merchantFeeUnits,
  usdToUnits,
  unitsToUsdMicro,
  gasWeiToMicro,
  busyNetworkFee,
  planAmounts,
  centsText,
};
