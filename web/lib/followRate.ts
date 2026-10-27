/**
 * In-memory brakes for follow reads and writes.
 *
 * A follow write is one row. The database cap is 1000 per account. This brake
 * stops a script from walking that cap in a few seconds. It lives in one
 * server instance, so it is not an exact count across instances.
 */

/** Keep the map bounded without forgetting the bucket that was just written. */
function trim(store: Map<string, number[]>, keep: string) {
  if (store.size <= 5000) return;
  for (const old of store.keys()) {
    if (store.size <= 5000) return;
    if (old !== keep) store.delete(old);
  }
}

export function takeBudget(
  store: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): boolean {
  const kept = (store.get(key) || []).filter((t) => now - t < windowMs);
  if (kept.length >= limit) {
    store.set(key, kept);
    trim(store, key);
    return false;
  }
  kept.push(now);
  store.set(key, kept);
  trim(store, key);
  return true;
}

const writes = new Map<string, number[]>();
const reads = new Map<string, number[]>();

/** 30 follow changes per account per hour. */
export function allowFollowWrite(accountId: string, now = Date.now()): boolean {
  return takeBudget(writes, accountId, 30, 60 * 60 * 1000, now);
}

/** 60 list or people reads per caller per minute. */
export function allowFollowRead(key: string, now = Date.now()): boolean {
  return takeBudget(reads, key, 60, 60 * 1000, now);
}
