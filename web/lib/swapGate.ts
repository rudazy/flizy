/**
 * Which site swaps need the account password, and the floor a swap may fill at.
 *
 * A swap's output always lands in the caller's own wallet, but that alone does
 * not keep value on the account. Flizy controls only the FLZ/WETH pool. Any
 * other token trades against a pool that whoever deployed the token can seed and
 * then drain: a stolen session could buy that token with the whole ETH balance,
 * and the pool owner removes liquidity and keeps the ETH. Selling a thin token
 * into a pool someone else controls leaks the same way in reverse.
 *
 * So a swap with any side other than ETH, WETH or FLZ needs the password, like
 * every other route that can move value off the account.
 */

export type VerifiedSwapTokens = { wrappedNative: string; flz: string };

/**
 * @param sides resolved token addresses; null is native ETH
 */
export function swapNeedsPassword(
  sides: Array<string | null>,
  verified: VerifiedSwapTokens
): boolean {
  const ok = new Set([verified.wrappedNative.toLowerCase(), verified.flz.toLowerCase()]);
  return sides.some((side) => side !== null && !ok.has(side.toLowerCase()));
}

/**
 * The minimum a swap may fill at: the stricter of the server's fresh quote and
 * the minimum the person confirmed on screen. Without the confirmed figure the
 * review step shows a price that execution does not honour.
 */
export function bindAmountOutMin(serverMin: bigint, confirmedMin: bigint | null): bigint {
  return confirmedMin != null && confirmedMin > serverMin ? confirmedMin : serverMin;
}
