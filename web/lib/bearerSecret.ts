/**
 * Constant time checks of a shared secret, for the routes that only a server
 * of ours or an operator calls (Vercel Cron, the bots, the health detail).
 *
 * Both sides are hashed first so the comparison is fixed length and an early
 * length mismatch cannot reveal how long the secret is. An unset secret
 * refuses everyone.
 */

import { createHash, timingSafeEqual } from 'crypto';

/** Whether offered equals secret, in constant time. */
export function secretMatches(offered: string | null, secret: string | undefined): boolean {
  if (!secret || !offered) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(offered), digest(secret));
}

/** Whether an "Authorization: Bearer <secret>" header carries secret. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  return secretMatches(header, `Bearer ${secret}`);
}
