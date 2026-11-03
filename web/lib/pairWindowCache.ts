import { unstable_cache } from 'next/cache';
import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { getDexAddresses } from './dexServer';
import { getWebChain } from './webChain.ts';
import { listedPairs } from './listedPairs.ts';
import { eventStoreMissing, isCurrent, pollPairs, readPairWindow, type PairWindow } from './pairEvents.ts';

/**
 * The listed pairs' last 24 hours from the event index, shared by every viewer
 * for 20 seconds.
 *
 * Each refresh first runs the getLogs poller (a bounded slice per call), so
 * the charts stay current with no webhook and no cron; the Nodit webhook
 * (app/api/webhooks/nodit) only makes a trade show up sooner.
 *
 * A pair is included only when its index reaches the chain head (isCurrent).
 * A pair that is behind, or a poll that failed, leaves that pair out, and its
 * row is built from the direct chain read instead: an index that has not
 * caught up must never show a pool as having no trades. Null when the index
 * cannot be used at all (the migration is not applied, or the database or
 * the RPC is unreachable).
 */

export type IndexedDays = { now: number; windows: Record<string, PairWindow> };

async function loadIndexedDays(): Promise<IndexedDays | null> {
  const chain = getWebChain();
  const pairs = listedPairs(getDexAddresses());
  const db = getSupabase();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  try {
    const polled = await pollPairs({ provider, db, chainId: chain.chainId, pairs });
    const now = Math.floor(Date.now() / 1000);
    const windows: Record<string, PairWindow> = {};
    for (const p of pairs) {
      if (!isCurrent(polled.indexedTo.get(p.pair), polled.head)) continue;
      windows[p.pair] = await readPairWindow(db, chain.chainId, p, now);
    }
    return { now, windows };
  } catch (err) {
    // A fixed line: an RPC error's text can carry the node URL and its key.
    if (!eventStoreMissing(err as { code?: string; message?: string })) {
      console.warn('[pair-index] index not used this time, using the chain read instead');
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
