/**
 * The client address of a request, as a hash, for the counters that limit
 * unauthenticated callers (signup, login).
 *
 * `x-real-ip` first: Vercel's proxy sets it to the single client address and
 * does not pass through a client-supplied one. `x-forwarded-for` is the
 * fallback, and the LAST entry is taken rather than the first, because entries
 * are appended as a request passes through proxies and the one nearest us is
 * the one we can believe. Reading the first entry would let a caller pick their
 * own bucket by sending the header themselves.
 *
 * Hashed so a counter table is not a plaintext list of addresses. Do not read
 * more into that than it earns: IPv4 is 2^32 values, so a plain digest is
 * reversible by anyone who wants to spend a few seconds on it, and this is not
 * anonymisation. It is a counter key that happens not to be legible at a
 * glance. Anyone who can read those tables holds the service role and has
 * worse things available to them already.
 *
 * An address we cannot read at all shares one bucket, which is the right
 * failure: local runs and any future non-Vercel host stay capped, not uncapped.
 */

import { createHash } from 'crypto';

export function clientIpKey(headers: Pick<Headers, 'get'>): string {
  const real = (headers.get('x-real-ip') || '').trim();
  let ip = real;

  if (!ip) {
    const forwarded = headers.get('x-forwarded-for') || '';
    const parts = forwarded
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    ip = parts.length ? parts[parts.length - 1] : '';
  }

  return createHash('sha256').update(ip || 'unknown').digest('hex');
}
