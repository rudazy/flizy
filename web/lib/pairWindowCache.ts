import { unstable_cache } from 'next/cache';
import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { getDexAddresses } from './dexServer';
import { getWebChain } from './webChain.ts';
import { listedPairs } from './listedPairs.ts';
import { eventStoreMissing, pollPairs, readPairWindow, type PairWindow } from './pairEvents.ts';

/**
 * The listed pairs' last 24 hours from the event index, shared by every viewer
 * for 20 seconds.
 *
 * Each refresh first runs the getLogs poller, so the charts stay current with
 * no webhook and no cron; the Nodit webhook (app/api/webhooks/nodit) only makes
 * a trade show up sooner. A poll that fails leaves what is already stored to
 * be read. Null when the index cannot be read at all (the migration is not
 * applied yet, or the database is unreachable): the caller then falls back to
 * reading the chain directly.
 */

export type IndexedDays = { now: number; windows: Record<string, PairWindow> };

async function loadIndexedDays(): Promise<IndexedDays | null> {
  const chain = getWebChain();
  const pairs = listedPairs(getDexAddresses());
  const db = getSupabase();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  try {
    try {
      await pollPairs({ provider, db, chainId: chain.chainId, pairs });
    } catch (err) {
      if (eventStoreMissing(err as { code?: string; message?: string })) return null;
      // A fixed line: an RPC error's text can carry the node URL and its key.
      console.warn('[pair-index] poll failed, reading what is stored');
    }
    const now = Math.floor(Date.now() / 1000);
    const windows: Record<string, PairWindow> = {};
    for (const p of pairs) windows[p.pair] = await readPairWindow(db, chain.chainId, p, now);
    return { now, windows };
  } catch (err) {
    if (!eventStoreMissing(err as { code?: string; message?: string })) {
      console.warn('[pair-index] read failed, using the chain read instead');
    }
    return null;
  } finally {
    try {
      provider.destroy();
    } catch {
      // The result is already decided. Closing the provider must not replace it.
    }
  }
}

export const cachedIndexedDays = unstable_cache(loadIndexedDays, ['pair-index-days'], { revalidate: 20 });
