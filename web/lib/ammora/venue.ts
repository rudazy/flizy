/**
 * Ammora as a swap venue: the rules that need no network.
 *
 * Mirror of lib/ammora/venue.js (web/ cannot import root lib/);
 * test/ammoraVenueDrift.test.js runs both on the same inputs. The pinned
 * config is the web copy written by scripts/ammora-pin.js. See the root file
 * for the rules: flag, the pinned router and its decoded calldata, Flizy
 * symbols first, the fee and price-impact view, exact approvals.
 */

import { ethers } from 'ethers';
import VENUE_JSON from '../generated/ammoraVenue.json' with { type: 'json' };

export type VenueConfig = {
  chainId: number;
  swapTargets: string[];
  contracts: Record<string, { address: string; codeHash: string; sdkCatalogHash: string | null }>;
  dbcFactoryStartBlock: string;
  attestation: string;
};

export const VENUE = VENUE_JSON as VenueConfig;
export const AMMORA_CHAIN_ID = 91342;
/** The SDK's marker for native ETH (AMMORA_NATIVE_TOKEN in 0.2.13). */
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export type AmmoraToken = { baseToken: string; symbol: string | null; tradable: boolean } & Record<string, unknown>;

export function ammoraEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.AMMORA_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Lower-case addresses a prepared Ammora swap may target or approve. */
export function swapTargets(config: VenueConfig = VENUE): Set<string> {
  return new Set(config.swapTargets.map((role) => config.contracts[role].address.toLowerCase()));
}

export function isSwapTarget(address: unknown, config: VenueConfig = VENUE): boolean {
  return typeof address === 'string' && swapTargets(config).has(address.toLowerCase());
}

/** The one router call Flizy sends. Written here, not taken from the SDK. */
const ROUTER_CALL = new ethers.Interface([
  'function swapExactInput((uint256 chainId, (address pool, address tokenIn, address tokenOut, bytes venueParams)[] hops, uint256 amountIn, uint256 minimumAmountOut, address recipient, uint256 deadline, address referrer, uint16 maximumIntegratorFeeBps, bool unwrapNative) p) payable',
]);
const MAX_HOPS = 4;

type RouterCall = {
  chainId: bigint;
  hops: Array<{ pool: string; tokenIn: string; tokenOut: string }>;
  amountIn: bigint;
  minimumAmountOut: bigint;
  recipient: string;
  referrer: string;
  maximumIntegratorFeeBps: bigint;
  unwrapNative: boolean;
};

/** The decoded swapExactInput parameters, or null for any other call. */
function decodeRouterCall(data: unknown): RouterCall | null {
  try {
    const tx = ROUTER_CALL.parseTransaction({ data: String(data || '0x') });
    return tx && tx.name === 'swapExactInput' ? (tx.args[0] as unknown as RouterCall) : null;
  } catch {
    return null;
  }
}

export function shortAddress(address: string | null | undefined): string {
  const a = String(address || '');
  return a.length === 42 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

/** How an Ammora token is named on every surface. */
export function ammoraTokenLabel(symbol: string | null | undefined, address: string, sanitize: (s: string) => string): string {
  const sym = sanitize(String(symbol || '')).trim() || 'token';
  return `${sym} (${shortAddress(address)}, Ammora)`;
}

export type ResolveResult<T> =
  | { ok: true; token: T }
  | { ok: false; reason: 'flizy_symbol' | 'unknown' | 'ambiguous' | 'not_tradable' };

/** Resolve what someone typed to one Ammora token. Flizy symbols always win. */
export function resolveAmmoraToken<T extends AmmoraToken>(raw: string, inventory: T[], flizySymbols: Iterable<string>): ResolveResult<T> {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'unknown' };
  // Before the address check: isAddress narrows text, so read the symbol form first.
  const wanted = text.toUpperCase();
  if (ethers.isAddress(text)) {
    const hit = inventory.find((t) => t.baseToken.toLowerCase() === text.toLowerCase());
    if (!hit) return { ok: false, reason: 'unknown' };
    return hit.tradable ? { ok: true, token: hit } : { ok: false, reason: 'not_tradable' };
  }
  const flizy = new Set([...flizySymbols].map((s) => String(s).toUpperCase()));
  if (flizy.has(wanted)) return { ok: false, reason: 'flizy_symbol' };
  const matches = inventory.filter((t) => String(t.symbol || '').trim().toUpperCase() === wanted);
  if (matches.length === 0) return { ok: false, reason: 'unknown' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  return matches[0].tradable ? { ok: true, token: matches[0] } : { ok: false, reason: 'not_tradable' };
}

export type FeeQuote = {
  amountIn: bigint;
  expectedAmountOut: bigint;
  priceImpactBps: bigint | null;
  fees: { total: bigint | null; token: string | null; lp?: bigint | null; protocol?: bigint | null; creator?: bigint | null };
};

/** The fee and price impact to show for an Ammora quote. */
export function ammoraFeeView(quote: FeeQuote, side: { nativeIn: boolean }) {
  const total = BigInt(quote.fees && quote.fees.total != null ? quote.fees.total : 0);
  const fees = (quote.fees || {}) as Record<string, unknown>;
  const classified = ['lp', 'protocol', 'creator'].some((k) => fees[k] != null);
  // The curve takes its fee in the quote asset (WETH): from the input on a
  // buy, from the output on a sell.
  const base = side.nativeIn ? BigInt(quote.amountIn) : BigInt(quote.expectedAmountOut) + total;
  const rateBps = base > 0n ? Number((total * 10_000n) / base) : null;
  return {
    feeWei: total,
    rateBps,
    label: classified ? 'Ammora fee' : 'Ammora curve fee',
    priceImpact: quote.priceImpactBps == null ? 'unavailable' : `${(Number(quote.priceImpactBps) / 100).toFixed(2)}%`,
  };
}

/** "1.25%" from basis points, or "" when unknown. */
export function bpsText(bps: number | null): string {
  return bps == null ? '' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export type PreparedLike = {
  transaction: { to: string; data: string; value?: bigint };
  approvalRequirements: Array<{ token: string; spender: string; amount: bigint; resetToZero?: boolean }>;
  quote: { tokenIn: string; tokenOut: string; amountIn: bigint; router: string | null };
};

/**
 * Is this prepared swap one Flizy will send? Checked after prepare, before any
 * transaction: the pinned router, and its decoded calldata held to the quote
 * (recipient, amounts, known pools, no integrator fee). See lib/ammora/venue.js.
 */
export function checkPrepared(
  prepared: PreparedLike | null | undefined,
  expect: {
    attested: boolean;
    tokenIn: string | null;
    tokenOut: string | null;
    amountIn: bigint;
    minimumAmountOut: bigint;
    recipient: string;
    pools: Iterable<string>;
    config?: VenueConfig;
  }
): { ok: true } | { ok: false; reason: string } {
  const config = expect.config || VENUE;
  if (!expect.attested) return { ok: false, reason: 'venue_off' };
  if (!prepared || !prepared.transaction || !isSwapTarget(prepared.transaction.to, config)) {
    return { ok: false, reason: 'router_not_pinned' };
  }
  const q = prepared.quote || ({} as PreparedLike['quote']);
  if (q.router != null && !isSwapTarget(q.router, config)) return { ok: false, reason: 'router_not_pinned' };
  const same = (a: unknown, b: unknown) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const weth = config.contracts.wrappedNative.address;
  const inOk = expect.tokenIn === null ? same(q.tokenIn, NATIVE) || same(q.tokenIn, weth) : same(q.tokenIn, expect.tokenIn);
  const outOk = expect.tokenOut === null ? same(q.tokenOut, NATIVE) || same(q.tokenOut, weth) : same(q.tokenOut, expect.tokenOut);
  if (!inOk || !outOk || BigInt(q.amountIn) !== BigInt(expect.amountIn)) return { ok: false, reason: 'quote_mismatch' };
  // ETH goes along only on a buy, and then exactly the amount in.
  const value = BigInt(prepared.transaction.value || 0n);
  if (value !== (expect.tokenIn === null ? BigInt(expect.amountIn) : 0n)) return { ok: false, reason: 'quote_mismatch' };

  const call = decodeRouterCall(prepared.transaction.data);
  if (!call) return { ok: false, reason: 'calldata' };
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
  let at: string = expect.tokenIn === null ? weth : expect.tokenIn;
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

/** Approvals to send, in order: zero first when needed, then the exact amount. */
export function approvalSteps(requirement: { amount: bigint; resetToZero?: boolean }, currentAllowance: bigint): bigint[] {
  const amount = BigInt(requirement.amount);
  const current = BigInt(currentAllowance || 0n);
  if (current === amount) return [];
  return current > 0n || requirement.resetToZero ? [0n, amount] : [amount];
}
