/**
 * The reference price that lets a swap or a liquidity change on a verified
 * pool skip the PIN.
 *
 * A swap between ETH and a verified token keeps the value in the account, so
 * the PIN is not what protects it. The price is. Someone holding a stolen
 * session could move the pool with a trade of their own, fire the owner's
 * swap into the moved price, then trade back and keep the difference. A
 * slippage limit cannot stop that: the quote is read after the pool moved.
 *
 * So the price is checked against a reference the attacker cannot move in
 * the same sitting. The WhatsApp process snapshots each verified pool's
 * reserves once per 15 minute bucket (lib/priceSnapshots.js, table
 * token_price_snapshots). The reference is the median of the newest four
 * snapshots. The check passes only when both hold (a swap must also be under
 * the hourly count in lib/tiers.js to skip the PIN):
 *   - the pool's current price is within 5% of the reference, and
 *   - the worst fill the trade accepts (its amountOutMin), valued at the
 *     reference, is within 5% of what goes in.
 * Anything missing, stale or unreadable asks for the PIN. Nothing is refused
 * here; a failed check only means the PIN.
 *
 * Prices are wei of ETH per smallest token unit, scaled by PRICE_SCALE, so
 * tokens of any decimals compare without floating point.
 *
 * Mirror of web/lib/priceReference.ts, which web/ cannot import from here on
 * Vercel. test/priceReferenceDrift.test.js keeps the two identical.
 */

const { ethers } = require('ethers');

/** How far the price may be from the reference without the PIN: 5%. */
const PRICE_GUARD_BPS = 500;
/** One snapshot per pool per bucket. */
const SNAPSHOT_BUCKET_MS = 15 * 60 * 1000;
/** Snapshots the median is taken over. */
const REFERENCE_SNAPSHOTS = 4;
/** The newest snapshot must be at most this old. */
const NEWEST_MAX_AGE_MS = 30 * 60 * 1000;
/** The oldest of the four must be at most this old (one bucket may be missing). */
const OLDEST_MAX_AGE_MS = 90 * 60 * 1000;
/** Fixed-point scale for prices. 36 digits keeps 6-decimal tokens precise. */
const PRICE_SCALE = 10n ** 36n;

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];

/**
 * The pools whose tokens Flizy verifies for swaps: FLZ and each listed token,
 * each paired with WETH.
 *
 * @param {{ flz: string, pair: string }} dex
 * @param {ReadonlyArray<{ address: string, pair: string }>} listed
 * @returns {Array<{ token: string, pair: string }>} lower-case addresses
 */
function verifiedPools(dex, listed) {
  const pools = [];
  if (dex.flz && dex.pair) pools.push({ token: dex.flz.toLowerCase(), pair: dex.pair.toLowerCase() });
  for (const t of listed) pools.push({ token: t.address.toLowerCase(), pair: t.pair.toLowerCase() });
  return pools;
}

/**
 * @param {ReturnType<typeof verifiedPools>} pools
 * @param {string|null|undefined} token
 */
function poolForToken(pools, token) {
  if (!token) return null;
  const lower = String(token).toLowerCase();
  return pools.find((p) => p.token === lower) || null;
}

/**
 * The bucket a moment falls in, as an ISO string (the table's unique key).
 * @param {number} nowMs
 */
function bucketStart(nowMs) {
  return new Date(Math.floor(nowMs / SNAPSHOT_BUCKET_MS) * SNAPSHOT_BUCKET_MS).toISOString();
}

/**
 * Wei of ETH per token unit, scaled. Null for an empty or unreadable pool.
 * @param {bigint|string|number} reserveEth
 * @param {bigint|string|number} reserveToken
 * @returns {bigint|null}
 */
function priceFromReserves(reserveEth, reserveToken) {
  let eth;
  let tok;
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
 *
 * @param {Array<{ bucket: string, reserve_eth: string|number, reserve_token: string|number }>} rows
 * @param {number} nowMs
 * @returns {bigint|null}
 */
function referencePrice(rows, nowMs) {
  if (!Array.isArray(rows)) return null;
  const points = [];
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

/**
 * Is value within PRICE_GUARD_BPS of ref, either side?
 * @param {bigint} value
 * @param {bigint} ref
 */
function withinBand(value, ref) {
  if (ref <= 0n) return false;
  const diff = value > ref ? value - ref : ref - value;
  return diff * 10000n <= ref * BigInt(PRICE_GUARD_BPS);
}

/**
 * @typedef {{ ok: boolean, reason: string }} PriceCheck
 */

/**
 * The pool's current price against the reference.
 * @param {{ reference: bigint|null, spot: bigint|null }} args
 * @returns {PriceCheck}
 */
function checkPoolPrice({ reference, spot }) {
  if (reference == null) return { ok: false, reason: 'no_reference' };
  if (spot == null) return { ok: false, reason: 'no_spot' };
  if (!withinBand(spot, reference)) return { ok: false, reason: 'price_moved' };
  return { ok: true, reason: 'in_band' };
}

/**
 * A swap between ETH and one verified token: the pool check, then the worst
 * fill the swap accepts, valued at the reference.
 *
 * @param {{
 *   reference: bigint|null,
 *   spot: bigint|null,
 *   inIsNative: boolean,
 *   amountIn: bigint,
 *   amountOutMin: bigint,
 * }} args amounts in wei (ETH) and smallest units (token)
 * @returns {PriceCheck}
 */
function checkSwapPrice({ reference, spot, inIsNative, amountIn, amountOutMin }) {
  const pool = checkPoolPrice({ reference, spot });
  if (!pool.ok) return pool;
  if (typeof amountIn !== 'bigint' || typeof amountOutMin !== 'bigint' || amountIn <= 0n || amountOutMin <= 0n) {
    return { ok: false, reason: 'bad_amount' };
  }
  // Both sides in wei of ETH at the reference price.
  const valueIn = inIsNative ? amountIn : (amountIn * reference) / PRICE_SCALE;
  const valueOut = inIsNative ? (amountOutMin * reference) / PRICE_SCALE : amountOutMin;
  if (valueIn <= 0n) return { ok: false, reason: 'bad_amount' };
  if (valueOut * 10000n < valueIn * BigInt(10000 - PRICE_GUARD_BPS)) return { ok: false, reason: 'worst_fill' };
  return { ok: true, reason: 'in_band' };
}

/**
 * The pool's reserves as (ETH side, token side), read now.
 * @param {import('ethers').Provider} provider
 * @param {{ token: string, pair: string }} pool
 * @returns {Promise<{ reserveEth: bigint, reserveToken: bigint }>}
 */
async function readPoolReserves(provider, pool) {
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
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} chainId
 * @param {string} token
 * @param {number} nowMs
 * @returns {Promise<bigint|null>}
 */
async function readReferencePrice(supabase, chainId, token, nowMs) {
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
  return referencePrice(data, nowMs);
}

/**
 * The price check for a swap, read fresh: reference from the snapshots, spot
 * from the pool. Any failure is a failed check (the PIN), never a throw.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   provider: import('ethers').Provider,
 *   chainId: number,
 *   pool: { token: string, pair: string } | null,
 *   inIsNative: boolean,
 *   amountIn: bigint,
 *   amountOutMin: bigint,
 *   nowMs?: number,
 * }} args
 * @returns {Promise<PriceCheck>}
 */
async function swapPriceCheck({ supabase, provider, chainId, pool, inIsNative, amountIn, amountOutMin, nowMs = Date.now() }) {
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

/**
 * The price check for a liquidity change on a verified pool.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   provider: import('ethers').Provider,
 *   chainId: number,
 *   pool: { token: string, pair: string } | null,
 *   nowMs?: number,
 * }} args
 * @returns {Promise<PriceCheck>}
 */
async function poolPriceCheck({ supabase, provider, chainId, pool, nowMs = Date.now() }) {
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

module.exports = {
  PRICE_GUARD_BPS,
  SNAPSHOT_BUCKET_MS,
  REFERENCE_SNAPSHOTS,
  NEWEST_MAX_AGE_MS,
  OLDEST_MAX_AGE_MS,
  PRICE_SCALE,
  verifiedPools,
  poolForToken,
  bucketStart,
  priceFromReserves,
  referencePrice,
  checkPoolPrice,
  checkSwapPrice,
  readPoolReserves,
  readReferencePrice,
  swapPriceCheck,
  poolPriceCheck,
};
