import type { getSupabase } from './supabase';
import { clientIpKey } from './clientIp.ts';

/**
 * Hourly caps per caller for the routes wallet mode reaches without a Flizy
 * session. Each of these costs chain or explorer reads, and a signed-in
 * caller is limited by having had to make an account; an anonymous one is
 * limited here instead, by a hash of the client address (web/lib/clientIp.ts).
 *
 * The counter is a row per call in external_pay_attempts, the table the
 * outside-wallet pay route already counts in, keyed "<bucket>:<hash>" so each
 * bucket counts on its own. Rows older than a day are deleted now and then by
 * the callers themselves, so anonymous traffic cannot grow the table without
 * bound.
 */

type Db = ReturnType<typeof getSupabase>;

export const CALLER_CAPS = {
  /** NFT and token pages, prices and swap quotes. A collection page makes about five reads. */
  read: 600,
  /** NFT trade plans: each one runs the same chain checks as a real trade. */
  plan: 60,
  /** Wallet-mode trade notices: each one reads a receipt and may message accounts. */
  notice: 30,
} as const;

type CallerBucket = keyof typeof CALLER_CAPS;

const HOUR_MS = 3600e3;
const KEEP_MS = 24 * HOUR_MS;

/**
 * Count this call and say whether it is within the bucket's hourly cap.
 *
 * Plans and notices refuse when the counter cannot be read, like the pay
 * route. Reads are public chain data the page needs to render, so an
 * unreadable counter lets them through rather than blanking every page.
 */
export async function takeCallerAttempt(
  supabase: Db,
  headers: Pick<Headers, 'get'>,
  bucket: CallerBucket,
  now = Date.now(),
  random: () => number = Math.random
): Promise<boolean> {
  const key = `${bucket}:${clientIpKey(headers)}`;
  const failOpen = bucket === 'read';
  const { count, error } = await supabase
    .from('external_pay_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip_key', key)
    .gte('created_at', new Date(now - HOUR_MS).toISOString());
  if (error) {
    if (failOpen) console.warn(`[limit] ${bucket} counter unreadable, call allowed`);
    return failOpen;
  }
  if ((count ?? 0) >= CALLER_CAPS[bucket]) return false;
  const { error: insErr } = await supabase.from('external_pay_attempts').insert({ ip_key: key });
  if (insErr && !failOpen) return false;
  // About one call in a hundred clears rows no cap looks at any more.
  if (random() < 0.01) {
    await supabase
      .from('external_pay_attempts')
      .delete()
      .lt('created_at', new Date(now - KEEP_MS).toISOString())
      .then(
        () => undefined,
        () => undefined
      );
  }
  return true;
}

/** The 429 body every capped route returns. */
export const CALLER_LIMITED = { error: 'Too many requests from here. Try again in a while.', code: 'CALLER_RATE_LIMITED' } as const;
