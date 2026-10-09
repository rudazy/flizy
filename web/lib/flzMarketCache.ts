import { unstable_cache } from 'next/cache';
import { loadFlzDay } from './tokenMarketServer';

/**
 * The FLZ pool's last 24 hours, shared by every viewer and every range for 20
 * seconds. One day is about ten log requests plus a receipt per recent trade,
 * so a caller looping the token or Explore route cannot turn each request into
 * that many RPC calls.
 */
export const cachedFlzDay = unstable_cache(() => loadFlzDay(), ['flz-day'], { revalidate: 20 });
