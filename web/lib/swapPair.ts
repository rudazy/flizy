/** The two sides of the one pool the swap screen trades. */
export type SwapToken = 'ETH' | 'FLZ';

/**
 * The pair a link asked for, as in /dashboard/swap?from=FLZ&to=ETH, or ETH to
 * FLZ when it asked for anything else. Only the ETH/FLZ pair exists, so the
 * only other valid answer is the same pair the other way round.
 */
export function pairFromQuery(from: string | null, to: string | null): { tokenIn: SwapToken; tokenOut: SwapToken } {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (f === 'FLZ' && (t === 'ETH' || t === '')) return { tokenIn: 'FLZ', tokenOut: 'ETH' };
  return { tokenIn: 'ETH', tokenOut: 'FLZ' };
}
