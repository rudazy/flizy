import { unstable_cache } from 'next/cache';
import { findEthPair, loadFlzDay, loadTokenDay, type TokenDay } from './tokenMarketServer';
import { listedByAddress } from './listedTokens';

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

/**
 * The same day for a listed token, read from the pool Flizy seeded and cached
 * per token for 20 seconds. Null for an address that is not listed.
 */
export const cachedListedDay = unstable_cache(
  async (address: string): Promise<TokenDay | null> => {
    const listed = listedByAddress(address);
    if (!listed) return null;
    return loadTokenDay({ token: listed.address, pair: listed.pair, symbol: listed.symbol, decimals: listed.decimals });
  },
  ['listed-day'],
  { revalidate: 20 }
);
