import { LISTED_TOKENS } from './listedTokens.ts';

/** ETH, and every token the swap screen trades against it. */
export const SWAP_ASSETS = ['FLZ', ...LISTED_TOKENS.map((token) => token.symbol)] as const;

/** One side of a swap: ETH, or a token with an ETH pool Flizy seeded. */
export type SwapToken = string;

function isAsset(symbol: string): boolean {
  return (SWAP_ASSETS as readonly string[]).includes(symbol);
}

/**
 * The pair a link asked for, as in /dashboard/swap?from=FLZ&to=ETH or
 * ?from=ETH&to=IZY, or ETH to FLZ when it asked for anything else. Every pool
 * is against ETH, so one side is always ETH.
 */
export function pairFromQuery(from: string | null, to: string | null): { tokenIn: SwapToken; tokenOut: SwapToken } {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (isAsset(f) && (t === 'ETH' || t === '')) return { tokenIn: f, tokenOut: 'ETH' };
  if (isAsset(t) && (f === 'ETH' || f === '')) return { tokenIn: 'ETH', tokenOut: t };
  return { tokenIn: 'ETH', tokenOut: 'FLZ' };
}
