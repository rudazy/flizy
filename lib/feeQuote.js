/**
 * A payment's fee, quoted from the chain and the fee ledger, and recorded once
 * the payment has landed. The rules themselves are lib/fees.js; this module
 * supplies their inputs and writes their result.
 *
 * - Price: ETH at FEE_ETH_USD_RATE, tUSD at $1, FLZ from the Flizy FLZ/WETH
 *   pool's reserves at that ETH rate. A spot price from a pool can be moved by
 *   trading in it, which on testnet only shifts a fee of cents; a manipulation
 *   resistant source replaces it before mainnet.
 * - Gas estimate: FEE_PAYMENT_GAS at the current max fee per gas: a UserOp
 *   carrying a payment and its fee, as measured on the local fork
 *   (scripts/fees-fork-check.js, 282,483 for an ETH batch), rounded up.
 * - Absorbed today: what the fee ledger records Flizy absorbed since 00:00 UTC.
 * - A quote is plain strings and numbers, so a plan holding one can be stored
 *   and read back; recordFee turns it into a fee_ledger row.
 */

const { ethers } = require('ethers');
const fees = require('./fees');
const { getPairReserves, getDexConfig } = require('./dex');
const { listedBySymbol } = require('./listedTokens');

const LEDGER = 'fee_ledger';
/** Gas a UserOp carrying a payment and its fee uses, from the fork measurement, rounded up. */
const FEE_PAYMENT_GAS = 300_000n;

/** Decimals of the assets a fee can be charged in. */
function feeDecimals(asset) {
  if (asset === 'ETH' || asset === 'FLZ') return 18;
  if (asset === 'TUSD') return Number(listedBySymbol('TUSD').decimals);
  throw new Error(`no fee is defined for ${asset}`);
}

/**
 * The USD price of one whole token of an asset, in micro-USD, and its source.
 * Throws when it cannot be read: no fee is ever made up.
 */
async function priceMicroFor(asset, { provider, cfg, chainKey }) {
  if (asset === 'ETH') return { priceMicro: cfg.ethUsd, source: 'FEE_ETH_USD_RATE' };
  if (asset === 'TUSD') return { priceMicro: fees.MICRO, source: 'tUSD at $1' };
  if (asset === 'FLZ') {
    const d = getDexConfig(chainKey);
    if (!d.flz) throw new Error('FLZ is not configured on this chain');
    const { reserveIn: reserveFlz, reserveOut: reserveWeth } = await getPairReserves(provider, { tokenIn: d.flz, tokenOut: null, chainKey });
    if (reserveFlz === 0n || reserveWeth === 0n) throw new Error('the FLZ pool is empty');
    // Both 18 decimals: USD per FLZ = (WETH per FLZ) x USD per ETH.
    const priceMicro = (BigInt(reserveWeth) * cfg.ethUsd) / BigInt(reserveFlz);
    if (priceMicro <= 0n) throw new Error('the FLZ price rounds to zero');
    return { priceMicro, source: 'Flizy FLZ/WETH pool' };
  }
  throw new Error(`no fee price for ${asset}`);
}

/** Start of the current UTC day. */
function utcDayStart(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** micro-USD of gas Flizy absorbed today across all accounts. Throws when it cannot be read. */
async function absorbedTodayMicro(supabase, now = Date.now()) {
  const { data, error } = await supabase.from(LEDGER).select('absorbed_usd_micro').gte('created_at', utcDayStart(now)).gt('absorbed_usd_micro', 0);
  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, r) => sum + BigInt(r.absorbed_usd_micro), 0n);
}

/**
 * The person-to-person fee for sending amountUnits of an asset.
 * @returns {Promise<{ kind: 'p2p', asset: string, decimals: number, feeUnits: string, feeMicro: string,
 *   tierMicro: string, gasEstMicro: string, absorbMicro: string, gasOverTier: boolean,
 *   priceMicro: string, priceSource: string, pricedAt: string, feeText: string }>}
 */
async function quoteP2pFee({ supabase, provider, asset, amountUnits, chainKey, cfg = fees.feeConfig(), now = Date.now(), log = console }) {
  const decimals = feeDecimals(asset);
  const { priceMicro, source } = await priceMicroFor(asset, { provider, cfg, chainKey });
  const amountMicro = fees.unitsToUsdMicro(BigInt(amountUnits), priceMicro, decimals);
  const tierMicro = fees.p2pTierMicro(amountMicro, cfg);
  const feeData = await provider.getFeeData();
  const maxFee = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const gasEstMicro = fees.gasWeiToMicro(FEE_PAYMENT_GAS * BigInt(maxFee), cfg);
  const absorbed = await absorbedTodayMicro(supabase, now);
  const decided = fees.busyNetworkFee({ tierMicro, gasMicro: gasEstMicro, absorbedTodayMicro: absorbed }, cfg);
  if (decided.gasOverTier) {
    log.warn(`[fees] gas estimate ${fees.centsText(gasEstMicro)} is above the ${fees.centsText(tierMicro)} tier fee: charging ${fees.centsText(decided.feeMicro)}`);
  }
  const feeUnits = fees.usdToUnits(decided.feeMicro, priceMicro, decimals);
  return {
    kind: 'p2p',
    asset,
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
 * The gas Flizy paid for a landed payment, in wei. On the relayer path the
 * relayer paid the whole transaction (gas used at its price, plus the L1 data
 * fee). On the wallet path Flizy paid only when the gas top-up funded the
 * UserOp, and then exactly its actualGasCost. Otherwise the wallet paid.
 * @param {{ path: 'relayer'|'wallet', toppedUp?: boolean, receipt: object, entryPoint?: string, gator?: string }} p
 */
function gasPaidWei({ path, toppedUp = false, receipt, entryPoint, gator }) {
  if (!receipt) return null;
  if (path === 'relayer') {
    const used = BigInt(receipt.gasUsed || 0n);
    const price = BigInt(receipt.gasPrice || receipt.effectiveGasPrice || 0n);
    const l1 = receipt.l1Fee != null ? BigInt(receipt.l1Fee) : 0n;
    return used * price + l1;
  }
  if (!toppedUp) return 0n;
  const ep = ethers.getAddress(entryPoint);
  const who = ethers.getAddress(gator);
  const iface = new ethers.Interface([
    'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  ]);
  for (const log of receipt.logs || []) {
    if (!log || !log.address || ethers.getAddress(log.address) !== ep) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: Array.from(log.topics), data: log.data });
    } catch {
      continue;
    }
    if (parsed && ethers.getAddress(parsed.args.sender) === who) return BigInt(parsed.args.actualGasCost);
  }
  return null;
}

/**
 * The fee_ledger row for a fee that has landed. Once per source and kind:
 * a second call records nothing. Throws when the row cannot be written.
 * @returns {Promise<'recorded'|'duplicate'>}
 */
async function recordFee({ supabase, sourceKind, sourceId, accountId = null, txHash = null, quote, gasPaid = null, cfg = fees.feeConfig() }) {
  const feeMicro = BigInt(quote.feeMicro);
  const gasUsd = gasPaid == null ? null : fees.gasWeiToMicro(BigInt(gasPaid), cfg);
  const { data, error } = await supabase
    .from(LEDGER)
    .upsert(
      {
        source_kind: sourceKind,
        source_id: sourceId,
        account_id: accountId,
        tx_hash: txHash ? String(txHash).toLowerCase() : null,
        kind: quote.kind,
        asset: quote.asset,
        fee_units: String(quote.feeUnits),
        fee_usd_micro: feeMicro.toString(),
        tier_usd_micro: quote.tierMicro == null ? null : String(quote.tierMicro),
        gas_est_usd_micro: quote.gasEstMicro == null ? null : String(quote.gasEstMicro),
        absorbed_usd_micro: String(quote.absorbMicro || '0'),
        gas_over_tier: Boolean(quote.gasOverTier),
        price_usd_micro: String(quote.priceMicro),
        price_source: quote.priceSource,
        priced_at: quote.pricedAt,
        gas_paid_wei: gasPaid == null ? null : BigInt(gasPaid).toString(),
        gas_paid_usd_micro: gasUsd == null ? null : gasUsd.toString(),
        net_usd_micro: gasUsd == null ? null : (feeMicro - gasUsd).toString(),
      },
      { onConflict: 'source_kind,source_id,kind', ignoreDuplicates: true }
    )
    .select('id');
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row && row.id ? 'recorded' : 'duplicate';
}

module.exports = { FEE_PAYMENT_GAS, feeDecimals, priceMicroFor, absorbedTodayMicro, quoteP2pFee, gasPaidWei, recordFee };
