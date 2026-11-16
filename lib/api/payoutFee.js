/**
 * The fee on a Flizy Pay API payout (lib/api/payoutWorker.js).
 *
 * The platform pays it, on top, in the payout's asset, in the same redeem as
 * the payout through its allowance; the recipient always gets the full amount.
 * Each platform has a mode, set only by Flizy (scripts/api-platform.mjs):
 *
 *   tier   the person-to-person fee tiers (lib/fees.js), the default
 *   bps    api_platforms.fee_bps of each payout, rounded up
 *   none   no fee
 *
 * Only with FEES_ENABLED. The ledger row is kind 'api_payout'. A payout whose
 * fee cannot be worked out waits and is tried again; nothing is sent without
 * its fee.
 */

const { ethers } = require('ethers');
const fees = require('../fees');
const { activeFeeConfig } = require('../engine/sendFee');
const { quoteP2pFee, priceMicroFor, feeDecimals } = require('../feeQuote');
const { publicErrorMessage } = require('../sanitize');

const MODES = Object.freeze(['tier', 'bps', 'none']);

/** The bps fee on amountUnits, priced for the ledger, or null when it rounds to 0. */
async function quoteBpsFee({ provider, asset, amountUnits, bps, chainKey, cfg, now = Date.now() }) {
  const decimals = feeDecimals(asset);
  const feeUnits = fees.merchantFeeUnits(BigInt(amountUnits), { merchantBps: bps });
  if (feeUnits === 0n) return null;
  const { priceMicro, source } = await priceMicroFor(asset, { provider, cfg, chainKey });
  const feeMicro = fees.unitsToUsdMicro(feeUnits, priceMicro, decimals);
  return {
    kind: 'api_payout',
    asset,
    decimals,
    feeUnits: feeUnits.toString(),
    feeMicro: feeMicro.toString(),
    tierMicro: null,
    gasEstMicro: null,
    absorbMicro: '0',
    gasOverTier: false,
    priceMicro: priceMicro.toString(),
    priceSource: source,
    pricedAt: new Date(now).toISOString(),
    feeText: fees.centsText(feeMicro),
  };
}

/**
 * The fee a payout carries, in the shape a plan holds (lib/engine/sendFee.js
 * attachSendFee): { ok: true, fee } with fee null when none applies, or
 * { ok: false, reason } when it cannot be worked out right now.
 * @param {{ platform: { payout_fee_mode?: string, fee_bps?: number }, asset: string, amountUnits: bigint,
 *   supabase: object, provider: object, chainKey: string, env?: object, log?: object }} p
 */
async function payoutFee({ platform, asset, amountUnits, supabase, provider, chainKey, env = process.env, log = console }) {
  let cfg;
  try {
    cfg = activeFeeConfig(env);
  } catch (err) {
    log.warn(`[api-payout] fee settings refused: ${publicErrorMessage(err)}`);
    return { ok: false, reason: 'fee settings unreadable' };
  }
  // On, the settings always name a treasury (lib/fees.js refuses them without one).
  if (!cfg) return { ok: true, fee: null };
  const mode = MODES.includes(platform.payout_fee_mode) ? platform.payout_fee_mode : 'tier';
  if (mode === 'none') return { ok: true, fee: null };

  let quote;
  try {
    if (mode === 'bps') {
      quote = await quoteBpsFee({ provider, asset, amountUnits, bps: Number(platform.fee_bps) || 0, chainKey, cfg });
    } else {
      quote = { ...(await quoteP2pFee({ supabase, provider, asset, amountUnits, chainKey, cfg, log })), kind: 'api_payout' };
    }
  } catch (err) {
    log.warn(`[api-payout] fee quote failed: ${publicErrorMessage(err)}`);
    return { ok: false, reason: 'fee unavailable' };
  }
  if (!quote) return { ok: true, fee: null };

  const decimals = quote.decimals;
  const feeUnits = BigInt(quote.feeUnits);
  const amount = BigInt(amountUnits);
  return {
    ok: true,
    fee: {
      ...quote,
      treasury: cfg.treasury,
      sendUnits: amount.toString(),
      totalUnits: (amount + feeUnits).toString(),
      feeHuman: ethers.formatUnits(feeUnits, decimals),
      sendHuman: ethers.formatUnits(amount, decimals),
      totalHuman: ethers.formatUnits(amount + feeUnits, decimals),
      requestedHuman: ethers.formatUnits(amount, decimals),
      // The recipient always gets the full amount: the fee is never taken from it.
      feeFromAmount: false,
    },
  };
}

module.exports = { MODES, payoutFee, quoteBpsFee };
