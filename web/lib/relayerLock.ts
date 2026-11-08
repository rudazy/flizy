import { randomBytes } from 'crypto';

/**
 * One transaction in flight at a time per sending key, for the site. The same
 * lease as the bots' (lib/custody/relayerLock.js), in the same table
 * (supabase/migrations/20261104130000_relayer_locks.sql), so a send from here
 * and one from either bot process never pick the same nonce.
 *
 * Hold it from the nonce pick until the node has accepted the transaction:
 * wrap the call that broadcasts (an ethers sendTransaction or contract write
 * resolves at that point) and wait for the receipt after. A caller that cannot
 * get the lease within WAIT_MS gets RelayerBusy, and nothing has been sent.
 */

/** Same as the bots: longer than a send can take under the lease. */
const LEASE_SEC = 150;
/** Shorter than the bots: a person is waiting on this request. */
const WAIT_MS = 10_000;
const POLL_MS = 250;

export class RelayerBusy extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RelayerBusy';
  }
}

type LockDb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> };

export async function withRelayerLock<T>(
  opts: { supabase: LockDb; relayer: string; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
  fn: () => Promise<T>
): Promise<T> {
  const address = String(opts.relayer || '').toLowerCase();
  const holder = randomBytes(16).toString('hex');
  const deadline = Date.now() + (opts.waitMs ?? WAIT_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    let taken = false;
    try {
      const { data, error } = await opts.supabase.rpc('try_relayer_lock', { p_relayer: address, p_holder: holder, p_ttl_seconds: LEASE_SEC });
      if (error) throw new Error(error.message || 'lock refused');
      taken = data === true;
    } catch (err) {
      throw new RelayerBusy(`could not read the relayer lock (${String(err instanceof Error ? err.message : err).slice(0, 120)})`);
    }
    if (taken) break;
    if (Date.now() >= deadline) throw new RelayerBusy('the escrow is busy with another send');
    await sleep(opts.pollMs ?? POLL_MS);
  }
  try {
    return await fn();
  } finally {
    try {
      await opts.supabase.rpc('release_relayer_lock', { p_relayer: address, p_holder: holder });
    } catch {
      // The lease expires on its own after LEASE_SEC.
    }
  }
}
