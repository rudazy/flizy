/**
 * Site swaps: which tokens are unverified, and the floor a swap may fill at.
 *
 * A swap's output always lands in the caller's own wallet, but that alone does
 * not keep value on the account. Flizy controls the FLZ/WETH pool and the pools
 * of the tokens it lists (listedTokens.ts). Any other token trades against a
 * pool that whoever deployed the token can seed and then drain: a stolen session
 * could buy that token with the whole ETH balance, and the pool owner removes
 * liquidity and keeps the ETH. Selling a thin token into a pool someone else
 * controls leaks the same way in reverse.
 *
 * Every site swap takes the account password. This decides whether the prompt
 * warns that the token is one Flizy has not verified. Mirror of isUnverifiedSwap
 * in lib/dex.js, which gates the same trades in chat; test/swapGateDrift.test.js
 * keeps the two verified sets identical.
 */

import { listedByAddress } from './listedTokens.ts';

export type VerifiedSwapTokens = { wrappedNative: string; flz: string };

/**
 * True when either side is a token other than native, WETH, FLZ or a listed token.
 * @param sides resolved token addresses; null is native ETH
 */
export function isUnverifiedSwap(
  sides: Array<string | null>,
  verified: VerifiedSwapTokens
): boolean {
  const ok = new Set([verified.wrappedNative.toLowerCase(), verified.flz.toLowerCase()]);
  return sides.some((side) => side !== null && !ok.has(side.toLowerCase()) && !listedByAddress(side));
}

/**
 * The minimum a swap may fill at: the stricter of the server's fresh quote and
 * the minimum the person confirmed on screen. Without the confirmed figure the
 * review step shows a price that execution does not honour.
 */
export function bindAmountOutMin(serverMin: bigint, confirmedMin: bigint | null): bigint {
  return confirmedMin != null && confirmedMin > serverMin ? confirmedMin : serverMin;
}

/** The slippage a person may pick on the swap screen: 0.1% to 5%. */
export const SLIPPAGE_BPS_MIN = 10;
export const SLIPPAGE_BPS_MAX = 500;

/**
 * A requested slippage in basis points, or undefined for the server default.
 * Anything outside the range is refused rather than clamped, so a request can
 * never quietly trade at a looser minimum than the one on screen.
 */
export function parseSlippageBps(raw: unknown): number | undefined {
  if (raw == null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < SLIPPAGE_BPS_MIN || n > SLIPPAGE_BPS_MAX) {
    throw new RangeError('Slippage must be between 0.1% and 5%.');
  }
  return n;
}
