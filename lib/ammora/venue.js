/**
 * Ammora as a swap venue: the rules that need no network.
 *
 * Mirror of web/lib/ammora/venue.ts (web/ cannot import root lib/);
 * test/ammoraVenueDrift.test.js runs both on the same inputs.
 *
 * - Flag: AMMORA_ENABLED, default off. Off means no Ammora call anywhere.
 * - Trust: deployments/ammora-giwa-sepolia.json, self-attested by Flizy
 *   (scripts/ammora-pin.js). A prepared swap may only target, and only
 *   approve, the pinned aggregation router, and its calldata is decoded and
 *   held field by field: recipient, amounts, pools, no integrator fee.
 * - Identity: token symbols on Ammora are chosen by whoever launched them. A
 *   Flizy symbol always means Flizy's token; an Ammora token with that symbol
 *   is reachable by contract address only. Any other symbol resolves only when
 *   exactly one Ammora token has it.
 * - Fees: Ammora reports one total, unclassified; it is shown as the Ammora
 *   curve fee with its rate. Price impact comes back null and is shown as
 *   unavailable, never as a number.
 * - Approvals: exact amount only, reset to zero first when an allowance is
 *   already there or the token asks for it.
 */

const { ethers } = require('ethers');
const VENUE = require('../../deployments/ammora-giwa-sepolia.json');

const AMMORA_CHAIN_ID = 91342;
/** The SDK's marker for native ETH (AMMORA_NATIVE_TOKEN in 0.2.13). */
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** @param {Record<string, string|undefined>} [env] */
function ammoraEnabled(env = process.env) {
  return String(env.AMMORA_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Lower-case addresses a prepared Ammora swap may target or approve. */
function swapTargets(config = VENUE) {
  return new Set(config.swapTargets.map((role) => config.contracts[role].address.toLowerCase()));
}

function isSwapTarget(address, config = VENUE) {
  return typeof address === 'string' && swapTargets(config).has(address.toLowerCase());
}

/**
 * The one router call Flizy sends: swapExactInput on the aggregation router.
 * Written here rather than taken from the SDK, so a different SDK build cannot
 * change what is checked.
 */
const ROUTER_CALL = new ethers.Interface([
  'function swapExactInput((uint256 chainId, (address pool, address tokenIn, address tokenOut, bytes venueParams)[] hops, uint256 amountIn, uint256 minimumAmountOut, address recipient, uint256 deadline, address referrer, uint16 maximumIntegratorFeeBps, bool unwrapNative) p) payable',
]);
/** More hops than this is not a route Flizy quotes. */
const MAX_HOPS = 4;

/** The decoded swapExactInput parameters, or null for any other call. */
function decodeRouterCall(data) {
  try {
    const tx = ROUTER_CALL.parseTransaction({ data: String(data || '0x') });
    return tx && tx.name === 'swapExactInput' ? tx.args[0] : null;
  } catch {
    return null;
  }
}

function shortAddress(address) {
  const a = String(address || '');
  return a.length === 42 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

/**
 * How an Ammora token is named on every surface: the sanitized symbol, the
 * short contract address, and the source.
 * @param {(s: string) => string} sanitize the surface's display sanitizer
 */
function ammoraTokenLabel(symbol, address, sanitize) {
  const sym = sanitize(String(symbol || '')).trim() || 'token';
  return `${sym} (${shortAddress(address)}, Ammora)`;
}

/**
 * Resolve what someone typed to one Ammora token.
 *
 * @param {string} raw a contract address or a symbol
 * @param {Array<{ baseToken: string, symbol: string|null, tradable: boolean }>} inventory
 * @param {Iterable<string>} flizySymbols every symbol Flizy itself knows
 * @returns {{ ok: true, token: object } | { ok: false, reason: 'flizy_symbol'|'unknown'|'ambiguous'|'not_tradable' }}
 */
function resolveAmmoraToken(raw, inventory, flizySymbols) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'unknown' };
  if (ethers.isAddress(text)) {
    const hit = inventory.find((t) => t.baseToken.toLowerCase() === text.toLowerCase());
    if (!hit) return { ok: false, reason: 'unknown' };
    return hit.tradable ? { ok: true, token: hit } : { ok: false, reason: 'not_tradable' };
  }
  const wanted = text.toUpperCase();
  const flizy = new Set([...flizySymbols].map((s) => String(s).toUpperCase()));
  if (flizy.has(wanted)) return { ok: false, reason: 'flizy_symbol' };
  const matches = inventory.filter((t) => String(t.symbol || '').trim().toUpperCase() === wanted);
  if (matches.length === 0) return { ok: false, reason: 'unknown' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  return matches[0].tradable ? { ok: true, token: matches[0] } : { ok: false, reason: 'not_tradable' };
}

/**
 * The fee and price impact to show for an Ammora quote.
 * @param {{ amountIn: bigint, expectedAmountOut: bigint, priceImpactBps: bigint|null,
 *   fees: { total: bigint, token: string, lp?: bigint|null, protocol?: bigint|null, creator?: bigint|null } }} quote
 * @param {{ nativeIn: boolean }} side
 */
function ammoraFeeView(quote, { nativeIn }) {
  const total = BigInt(quote.fees && quote.fees.total != null ? quote.fees.total : 0);
  const classified = ['lp', 'protocol', 'creator'].some((k) => quote.fees && quote.fees[k] != null);
  // The curve takes its fee in the quote asset (WETH): from the input on a
  // buy, from the output on a sell.
  const base = nativeIn ? BigInt(quote.amountIn) : BigInt(quote.expectedAmountOut) + total;
  const rateBps = base > 0n ? Number((total * 10_000n) / base) : null;
  return {
    feeWei: total,
    rateBps,
    label: classified ? 'Ammora fee' : 'Ammora curve fee',
    priceImpact: quote.priceImpactBps == null ? 'unavailable' : `${(Number(quote.priceImpactBps) / 100).toFixed(2)}%`,
  };
}

/** "1.25%" from basis points, or "" when unknown. */
function bpsText(bps) {
  return bps == null ? '' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/**
 * Is this prepared swap one Flizy will send? Checked on every Ammora swap,
 * after prepare and before any transaction.
 *
 * The target and spender must be the pinned router, and the router call is
 * decoded and held to what Flizy quoted: the chain, the input amount, the
 * minimum out, the recipient (the account's own smart account), no referrer
 * and no integrator fee, unwrap only on a sell, and every hop through a pool
 * Flizy discovered from the pinned factory.
 *
 * @param {{ transaction: { to: string, data: string, value?: bigint }, approvalRequirements: Array<{ token: string, spender: string, amount: bigint }>,
 *   quote: { tokenIn: string, tokenOut: string, amountIn: bigint, router: string|null } }} prepared
 * @param {{ attested: boolean, tokenIn: string|null, tokenOut: string|null, amountIn: bigint, minimumAmountOut: bigint,
 *   recipient: string, pools: Iterable<string>, config?: object }} expect
 *   tokenIn / tokenOut null for native ETH; pools the stored Ammora pool addresses
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkPrepared(prepared, expect) {
  const config = expect.config || VENUE;
  if (!expect.attested) return { ok: false, reason: 'venue_off' };
  if (!prepared || !prepared.transaction || !isSwapTarget(prepared.transaction.to, config)) {
    return { ok: false, reason: 'router_not_pinned' };
  }
  const q = prepared.quote || {};
  if (q.router != null && !isSwapTarget(q.router, config)) return { ok: false, reason: 'router_not_pinned' };
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const inOk = expect.tokenIn === null ? same(q.tokenIn, NATIVE) || same(q.tokenIn, config.contracts.wrappedNative.address) : same(q.tokenIn, expect.tokenIn);
  const outOk = expect.tokenOut === null ? same(q.tokenOut, NATIVE) || same(q.tokenOut, config.contracts.wrappedNative.address) : same(q.tokenOut, expect.tokenOut);
  if (!inOk || !outOk || BigInt(q.amountIn) !== BigInt(expect.amountIn)) return { ok: false, reason: 'quote_mismatch' };
  // ETH goes along only on a buy, and then exactly the amount in.
  const value = BigInt(prepared.transaction.value || 0n);
  if (value !== (expect.tokenIn === null ? BigInt(expect.amountIn) : 0n)) return { ok: false, reason: 'quote_mismatch' };

  const call = decodeRouterCall(prepared.transaction.data);
  if (!call) return { ok: false, reason: 'calldata' };
  const weth = config.contracts.wrappedNative.address;
  if (
    BigInt(call.chainId) !== BigInt(config.chainId) ||
    BigInt(call.amountIn) !== BigInt(expect.amountIn) ||
    BigInt(call.minimumAmountOut) <= 0n ||
    BigInt(call.minimumAmountOut) !== BigInt(expect.minimumAmountOut) ||
    Boolean(call.unwrapNative) !== (expect.tokenOut === null)
  ) {
    return { ok: false, reason: 'calldata' };
  }
  if (!expect.recipient || !same(call.recipient, expect.recipient)) return { ok: false, reason: 'recipient' };
  if (!same(call.referrer, ethers.ZeroAddress) || Number(call.maximumIntegratorFeeBps) !== 0) {
    return { ok: false, reason: 'integrator_fee' };
  }
  const hops = Array.from(call.hops || []);
  const pools = new Set([...(expect.pools || [])].map((a) => String(a).toLowerCase()));
  if (hops.length === 0 || hops.length > MAX_HOPS) return { ok: false, reason: 'calldata' };
  let at = expect.tokenIn === null ? weth : expect.tokenIn;
  for (const hop of hops) {
    if (!pools.has(String(hop.pool).toLowerCase())) return { ok: false, reason: 'pool_not_known' };
    if (!same(hop.tokenIn, at)) return { ok: false, reason: 'calldata' };
    at = hop.tokenOut;
  }
  if (!same(at, expect.tokenOut === null ? weth : expect.tokenOut)) return { ok: false, reason: 'calldata' };

  for (const req of prepared.approvalRequirements || []) {
    if (!isSwapTarget(req.spender, config)) return { ok: false, reason: 'approval_spender' };
    if (expect.tokenIn === null || !same(req.token, expect.tokenIn)) return { ok: false, reason: 'approval_token' };
    if (BigInt(req.amount) > BigInt(expect.amountIn)) return { ok: false, reason: 'approval_amount' };
  }
  return { ok: true };
}

/**
 * The approvals to send, in order: zero first when an allowance is already
 * there or the token asks for a reset, then the exact amount. Never more than
 * the requirement, never unlimited.
 * @returns {bigint[]}
 */
function approvalSteps(requirement, currentAllowance) {
  const amount = BigInt(requirement.amount);
  const current = BigInt(currentAllowance || 0n);
  if (current === amount) return [];
  return current > 0n || requirement.resetToZero ? [0n, amount] : [amount];
}

module.exports = {
  VENUE,
  AMMORA_CHAIN_ID,
  NATIVE,
  ammoraEnabled,
  swapTargets,
  isSwapTarget,
  shortAddress,
  ammoraTokenLabel,
  resolveAmmoraToken,
  ammoraFeeView,
  bpsText,
  checkPrepared,
  approvalSteps,
};
