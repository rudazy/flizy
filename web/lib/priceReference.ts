/**
 * The reference price that lets a swap or a liquidity change on a verified
 * pool skip the PIN.
 *
 * Mirror of lib/priceReference.js, which web/ cannot import on Vercel. The
 * reasoning is written there. In short: the check passes only when the
 * pool's current price is within 5% of the median of the newest four
 * 15-minute snapshots (token_price_snapshots, written by the WhatsApp
 * process), and the worst fill the trade accepts is within 5% of the
 * reference value. A swap must also be under the hourly count in
 * web/lib/tiers.ts to skip the PIN. Anything missing, stale or unreadable
 * asks for the PIN.
 *
 * test/priceReferenceDrift.test.js keeps the two identical.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

/** How far the price may be from the reference without the PIN: 5%. */
export const PRICE_GUARD_BPS = 500;
/** One snapshot per pool per bucket. */
export const SNAPSHOT_BUCKET_MS = 15 * 60 * 1000;
/** Snapshots the median is taken over. */
export const REFERENCE_SNAPSHOTS = 4;
/** The newest snapshot must be at most this old. */
export const NEWEST_MAX_AGE_MS = 30 * 60 * 1000;
/** The oldest of the four must be at most this old (one bucket may be missing). */
export const OLDEST_MAX_AGE_MS = 90 * 60 * 1000;
/** Fixed-point scale for prices. 36 digits keeps 6-decimal tokens precise. */
export const PRICE_SCALE = 10n ** 36n;

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];

export type VerifiedPool = { token: string; pair: string };
export type PriceCheck = { ok: boolean; reason: string };
export type SnapshotRow = { bucket: string; reserve_eth: string | number; reserve_token: string | number };

/**
 * The pools whose tokens Flizy verifies for swaps: FLZ and each listed token,
 * each paired with WETH. Lower-case addresses.
 */
export function verifiedPools(
  dex: { flz: string; pair: string },
  listed: ReadonlyArray<{ address: string; pair: string }>
): VerifiedPool[] {
  const pools: VerifiedPool[] = [];
  if (dex.flz && dex.pair) pools.push({ token: dex.flz.toLowerCase(), pair: dex.pair.toLowerCase() });
  for (const t of listed) pools.push({ token: t.address.toLowerCase(), pair: t.pair.toLowerCase() });
  return pools;
}

export function poolForToken(pools: VerifiedPool[], token: string | null | undefined): VerifiedPool | null {
  if (!token) return null;
  const lower = String(token).toLowerCase();
  return pools.find((p) => p.token === lower) || null;
}

/** The bucket a moment falls in, as an ISO string (the table's unique key). */
export function bucketStart(nowMs: number): string {
  return new Date(Math.floor(nowMs / SNAPSHOT_BUCKET_MS) * SNAPSHOT_BUCKET_MS).toISOString();
}

/** Wei of ETH per token unit, scaled. Null for an empty or unreadable pool. */
export function priceFromReserves(reserveEth: bigint | string | number, reserveToken: bigint | string | number): bigint | null {
  let eth: bigint;
  let tok: bigint;
  try {
    eth = BigInt(reserveEth);
    tok = BigInt(reserveToken);
  } catch {
    return null;
  }
  if (eth <= 0n || tok <= 0n) return null;
  return (eth * PRICE_SCALE) / tok;
}

/**
 * The median of the newest four snapshots, or null when there are fewer than
 * four, the newest is over 30 minutes old, or the oldest is over 90 minutes.
 */
export function referencePrice(rows: SnapshotRow[], nowMs: number): bigint | null {
  if (!Array.isArray(rows)) return null;
  const points: Array<{ at: number; price: bigint }> = [];
  for (const row of rows) {
    const at = Date.parse(String(row?.bucket ?? ''));
    const price = priceFromReserves(String(row?.reserve_eth ?? ''), String(row?.reserve_token ?? ''));
    // A snapshot from the future is a clock or data fault, never a reference.
    if (!Number.isFinite(at) || at > nowMs || price == null) continue;
    points.push({ at, price });
  }
  points.sort((a, b) => b.at - a.at);
  const newest = points.slice(0, REFERENCE_SNAPSHOTS);
  if (newest.length < REFERENCE_SNAPSHOTS) return null;
  if (nowMs - newest[0].at > NEWEST_MAX_AGE_MS) return null;
  if (nowMs - newest[newest.length - 1].at > OLDEST_MAX_AGE_MS) return null;
  const sorted = newest.map((p) => p.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (sorted[1] + sorted[2]) / 2n;
}

/** Is value within PRICE_GUARD_BPS of ref, either side? */
function withinBand(value: bigint, ref: bigint): boolean {
  if (ref <= 0n) return false;
  const diff = value > ref ? value - ref : ref - value;
  return diff * 10000n <= ref * BigInt(PRICE_GUARD_BPS);
}

/** The pool's current price against the reference. */
export function checkPoolPrice({ reference, spot }: { reference: bigint | null; spot: bigint | null }): PriceCheck {
  if (reference == null) return { ok: false, reason: 'no_reference' };
  if (spot == null) return { ok: false, reason: 'no_spot' };
  if (!withinBand(spot, reference)) return { ok: false, reason: 'price_moved' };
  return { ok: true, reason: 'in_band' };
}

/**
 * A swap between ETH and one verified token: the pool check, then the worst
 * fill the swap accepts, valued at the reference. Amounts in wei (ETH) and
 * smallest units (token).
 */
export function checkSwapPrice({
  reference,
  spot,
  inIsNative,
  amountIn,
  amountOutMin,
}: {
  reference: bigint | null;
  spot: bigint | null;
  inIsNative: boolean;
  amountIn: bigint;
  amountOutMin: bigint;
}): PriceCheck {
  const pool = checkPoolPrice({ reference, spot });
  if (!pool.ok) return pool;
  if (typeof amountIn !== 'bigint' || typeof amountOutMin !== 'bigint' || amountIn <= 0n || amountOutMin <= 0n) {
    return { ok: false, reason: 'bad_amount' };
  }
  const ref = reference as bigint;
  // Both sides in wei of ETH at the reference price.
  const valueIn = inIsNative ? amountIn : (amountIn * ref) / PRICE_SCALE;
  const valueOut = inIsNative ? (amountOutMin * ref) / PRICE_SCALE : amountOutMin;
  if (valueIn <= 0n) return { ok: false, reason: 'bad_amount' };
  if (valueOut * 10000n < valueIn * BigInt(10000 - PRICE_GUARD_BPS)) return { ok: false, reason: 'worst_fill' };
  return { ok: true, reason: 'in_band' };
}

/** The pool's reserves as (ETH side, token side), read now. */
export async function readPoolReserves(
  provider: ethers.Provider,
  pool: VerifiedPool
): Promise<{ reserveEth: bigint; reserveToken: bigint }> {
  const pair = new ethers.Contract(pool.pair, PAIR_ABI, provider);
  const [reserves, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
  const tokenIs0 = String(t0).toLowerCase() === pool.token.toLowerCase();
  return {
    reserveEth: BigInt(tokenIs0 ? reserves[1] : reserves[0]),
    reserveToken: BigInt(tokenIs0 ? reserves[0] : reserves[1]),
  };
}

/**
 * The reference for one pool, read from token_price_snapshots. A read that
 * fails gives null, which asks for the PIN.
 */
export async function readReferencePrice(
  supabase: SupabaseClient,
  chainId: number,
  token: string,
  nowMs: number
): Promise<bigint | null> {
  // Reserves as text: PostgREST returns numeric as a JSON number, which loses
  // the digits of an 18-decimal reserve and would make every snapshot unreadable.
  const { data, error } = await supabase
    .from('token_price_snapshots')
    .select('bucket, reserve_eth::text, reserve_token::text')
    .eq('chain_id', chainId)
    .eq('token', String(token).toLowerCase())
    .lte('bucket', new Date(nowMs).toISOString())
    .order('bucket', { ascending: false })
    .limit(REFERENCE_SNAPSHOTS);
  if (error || !Array.isArray(data)) return null;
  return referencePrice(data as SnapshotRow[], nowMs);
}

/**
 * The price check for a swap, read fresh: reference from the snapshots, spot
 * from the pool. Any failure is a failed check (the PIN), never a throw.
 */
export async function swapPriceCheck(args: {
  supabase: SupabaseClient;
  provider: ethers.Provider;
  chainId: number;
  pool: VerifiedPool | null;
  inIsNative: boolean;
  amountIn: bigint;
  amountOutMin: bigint;
  nowMs?: number;
}): Promise<PriceCheck> {
  const { supabase, provider, chainId, pool, inIsNative, amountIn, amountOutMin, nowMs = Date.now() } = args;
  if (!pool) return { ok: false, reason: 'no_pool' };
  try {
    const [reference, reserves] = await Promise.all([
      readReferencePrice(supabase, chainId, pool.token, nowMs),
      readPoolReserves(provider, pool),
    ]);
    const spot = priceFromReserves(reserves.reserveEth, reserves.reserveToken);
    return checkSwapPrice({ reference, spot, inIsNative, amountIn, amountOutMin });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** The price check for a liquidity change on a verified pool. */
export async function poolPriceCheck(args: {
  supabase: SupabaseClient;
  provider: ethers.Provider;
  chainId: number;
  pool: VerifiedPool | null;
  nowMs?: number;
}): Promise<PriceCheck> {
  const { supabase, provider, chainId, pool, nowMs = Date.now() } = args;
  if (!pool) return { ok: false, reason: 'no_pool' };
  try {
    const [reference, reserves] = await Promise.all([
      readReferencePrice(supabase, chainId, pool.token, nowMs),
      readPoolReserves(provider, pool),
    ]);
    return checkPoolPrice({ reference, spot: priceFromReserves(reserves.reserveEth, reserves.reserveToken) });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
