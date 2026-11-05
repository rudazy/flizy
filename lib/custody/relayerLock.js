/**
 * One relayer transaction in flight at a time, per relayer key
 * (supabase/migrations/20261104130000_relayer_locks.sql).
 *
 * A relayer takes its nonce from the node's pending count, so two sends that
 * pick it at the same moment collide and the node refuses the second. The
 * lease is held from the nonce pick until the node has accepted the
 * transaction; after that the pending count already includes it. Waiting for
 * the receipt happens outside the lease.
 *
 * The lease lives in the database because chat sends and the approvals worker
 * run in more than one bot process. It expires on its own after LEASE_SEC, so
 * a process that dies holding it frees it. A caller that cannot get it within
 * WAIT_MS gets RelayerBusy, and nothing has been sent.
 */

const crypto = require('crypto');

/**
 * lib/custody/redeem.js gives up signing after 60 s and the broadcast after
 * another 60 s, which leaves 30 s of the lease for recording the hash between
 * them. A lease that expired under a live holder would let a second send pick
 * the same nonce. Its length only matters after a crash, when chat sends fall
 * back after WAIT_MS anyway.
 */
const LEASE_SEC = 150;
/** How long a send waits for another one to clear before giving up. */
const WAIT_MS = 20_000;
const POLL_MS = 250;

class RelayerBusy extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RelayerBusy';
    this.reason = reason;
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` holding the relayer's lease. Throws RelayerBusy, before `fn` runs,
 * when the lease cannot be taken in time or the lock cannot be read.
 */
async function withRelayerLock({ supabase, relayer, waitMs = WAIT_MS, pollMs = POLL_MS, sleep = sleepMs }, fn) {
  if (!supabase || typeof supabase.rpc !== 'function') throw new RelayerBusy('no database to hold the relayer lock');
  const address = String(relayer || '').toLowerCase();
  const holder = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + waitMs;
  for (;;) {
    let taken = false;
    try {
      const { data, error } = await supabase.rpc('try_relayer_lock', { p_relayer: address, p_holder: holder, p_ttl_seconds: LEASE_SEC });
      if (error) throw new Error(error.message || 'lock refused');
      taken = data === true;
    } catch (err) {
      throw new RelayerBusy(`could not read the relayer lock (${String(err && err.message ? err.message : err).slice(0, 120)})`);
    }
    if (taken) break;
    if (Date.now() >= deadline) throw new RelayerBusy('the relayer is busy with another send');
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    try {
      await supabase.rpc('release_relayer_lock', { p_relayer: address, p_holder: holder });
    } catch {
      // The lease expires on its own after LEASE_SEC.
    }
  }
}

module.exports = { withRelayerLock, RelayerBusy };
