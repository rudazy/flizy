/**
 * Constant time check of an "Authorization: Bearer <secret>" header, for the
 * routes that only a server of ours calls (Vercel Cron, the bots).
 *
 * Both sides are hashed first so the comparison is fixed length and an early
 * length mismatch cannot reveal how long the secret is. An unset secret
 * refuses everyone.
 */

import { createHash, timingSafeEqual } from 'crypto';

export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
