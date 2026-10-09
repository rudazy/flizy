import { unstable_cache } from 'next/cache';
import { findEthPair, loadFlzDay, loadTokenDay, type TokenDay } from './tokenMarketServer';

/**
 * The FLZ pool's last 24 hours, shared by every viewer and every range for 20
 * seconds. One day is about ten log requests plus a receipt per recent trade,
 * so a caller looping the token or Explore route cannot turn each request into
 * that many RPC calls.
 */
export const cachedFlzDay = unstable_cache(() => loadFlzDay(), ['flz-day'], { revalidate: 20 });

/**
 * The same day for an imported token, cached per token for 20 seconds the same
 * way. Null when the swap router has no ETH pool for it. The route only calls
 * this for a token the account saved or holds.
 */
export const cachedTokenDay = unstable_cache(
  async (address: string, symbol: string, decimals: number): Promise<TokenDay | null> => {
    const pair = await findEthPair(address);
    if (!pair) return null;
    return loadTokenDay({ token: address, pair, symbol, decimals });
  },
  ['token-day'],
  { revalidate: 20 }
);
