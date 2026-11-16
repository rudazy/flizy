/**
 * The swap fee in the fee ledger.
 *
 * FlizyFeeRouter takes its fee (SWAP_FEE_BPS, 30 by default) from the token
 * sold and sends it to its treasury in the same transaction, emitting
 * FeeTaken(payer, token, amount): token is the zero address for ETH. Once a
 * swap through the router has landed, this reads that event from the receipt
 * and records the fee as charged, kind 'swap', against the swap's transfers
 * row, so rewards can be worked out from it like any other fee.
 *
 * Only ETH, FLZ and listed tokens (lib/listedTokens.js) are recorded. A fee in
 * a token Flizy does not list is priced by a pool its creator controls, so it
 * is left out of the ledger (the treasury still has it). Ammora swaps carry no
 * Flizy fee. Never throws: the swap has already happened.
 */

const { ethers } = require('ethers');
const fees = require('./fees');
const { priceMicroFor, feeDecimals, recordFee, gasPaidWei } = require('./feeQuote');
const { getDexConfig } = require('./dex');
const { listedByAddress } = require('./listedTokens');
const { publicErrorMessage } = require('./sanitize');

const FEE_TAKEN = new ethers.Interface(['event FeeTaken(address indexed payer, address token, uint256 amount)']);

/** The FeeTaken events a receipt carries from the fee router, optionally only for one payer. */
function feeTakenFrom(receipt, feeRouter, payer = null) {
  const router = ethers.getAddress(feeRouter);
  const who = payer ? ethers.getAddress(payer) : null;
  const out = [];
  for (const log of (receipt && receipt.logs) || []) {
    if (!log || !log.address || ethers.getAddress(log.address) !== router) continue;
    let parsed = null;
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
function feeAssetOf(token, chainKey) {
  if (token === ethers.ZeroAddress) return 'ETH';
  const d = getDexConfig(chainKey);
  if (d.flz && ethers.getAddress(d.flz) === token) return 'FLZ';
  const listed = listedByAddress(token);
  return listed ? listed.symbol : null;
}

/**
 * Record a landed swap's fee. payer is the wallet that called the router: the
 * smart account (gator), or a plain wallet, which paid its own gas. A smart
 * account's gas was Flizy's only when the gas top-up funded it, as for a send.
 * Returns 'recorded', 'duplicate' or why nothing was recorded. Never throws.
 */
async function recordSwapFee({ supabase, provider, receipt, transferId, accountId, payer, gator = null, chainKey, env = process.env, log = console }) {
  try {
    if (!receipt || receipt.status !== 1 || !transferId) return 'no swap';
    const d = getDexConfig(chainKey);
    if (!d.feeRouter) return 'no fee router';
    const [taken] = feeTakenFrom(receipt, d.feeRouter, payer);
    if (!taken || taken.amount === 0n) return 'no fee';
    const asset = feeAssetOf(taken.token, chainKey);
    if (!asset) return 'unlisted token';
    const cfg = fees.feeConfig(env);
    const decimals = feeDecimals(asset);
    const { priceMicro, source } = await priceMicroFor(asset, { provider, cfg, chainKey });
    const feeMicro = fees.unitsToUsdMicro(taken.amount, priceMicro, decimals);
    const quote = {
      kind: 'swap',
      asset,
      feeUnits: taken.amount.toString(),
      feeMicro: feeMicro.toString(),
      tierMicro: null,
      gasEstMicro: null,
      absorbMicro: '0',
      gasOverTier: false,
      priceMicro: priceMicro.toString(),
      priceSource: source,
      pricedAt: new Date().toISOString(),
    };
    let toppedUp = false;
    try {
      toppedUp = require('./gasTopup').topupConfig(env).enabled;
    } catch {
      toppedUp = false;
    }
    const gasPaid = gator ? gasPaidWei({ path: 'wallet', toppedUp, receipt, entryPoint: require('./gatorAccount').gatorAddresses().entryPointV07, gator }) : 0n;
    return await recordFee({ supabase, sourceKind: 'transfer', sourceId: transferId, accountId, txHash: receipt.hash || receipt.transactionHash || null, quote, gasPaid, cfg });
  } catch (err) {
    log.error(`[fees] a swap fee was not recorded in the ledger: ${publicErrorMessage(err)}`);
    return 'failed';
  }
}

module.exports = { feeTakenFrom, feeAssetOf, recordSwapFee };
