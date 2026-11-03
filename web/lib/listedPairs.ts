import { LISTED_TOKENS } from './listedTokens.ts';

/**
 * The pairs the event index covers: FLZ's pool and each listed token's pool,
 * from the token config. Nothing else is indexed; the factory's other pairs
 * are never enumerated. The caller passes the FLZ and WETH addresses
 * (getDexAddresses on the site, lib/dex.js in a script), so this file has no
 * environment of its own.
 */

export type ListedPair = {
  symbol: string;
  token: string;
  /** Lower case, as stored in pair_events. */
  pair: string;
  decimals: number;
  /** Uniswap V2 orders a pair's tokens by address: the token is token0 when its address sorts first. */
  tokenIs0: boolean;
};

export function listedPairs(dex: { flz: string; pair: string; wrappedNative: string }): ListedPair[] {
  const weth = dex.wrappedNative.toLowerCase();
  const make = (symbol: string, token: string, pair: string, decimals: number): ListedPair => ({
    symbol,
    token,
    pair: pair.toLowerCase(),
    decimals,
    tokenIs0: token.toLowerCase() < weth,
  });
  return [
    make('FLZ', dex.flz, dex.pair, 18),
    ...LISTED_TOKENS.map((t) => make(t.symbol, t.address, t.pair, t.decimals)),
  ];
}

/** ETH per whole token from a pair's reserves, or null when either side is empty. */
export function pairPriceEth(p: ListedPair, reserve0: bigint, reserve1: bigint): number | null {
  const reserveToken = p.tokenIs0 ? reserve0 : reserve1;
  const reserveEth = p.tokenIs0 ? reserve1 : reserve0;
  if (reserveToken <= 0n || reserveEth <= 0n) return null;
  const price = (Number(reserveEth) / 1e18) / (Number(reserveToken) / 10 ** p.decimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}
