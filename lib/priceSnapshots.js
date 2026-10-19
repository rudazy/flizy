/**
 * Writes the reference prices lib/priceReference.js reads: one reserves
 * snapshot per verified pool per 15 minute bucket, into token_price_snapshots.
 *
 * Ticks every 5 minutes. A bucket that already has a row is left alone (the
 * insert ignores duplicates on chain, token and bucket), so a restart or a
 * second writer never adds a second snapshot to one bucket. Rows older than
 * two days are deleted once an hour; the reference only reads the last 90
 * minutes.
 *
 * A pool that cannot be read is skipped for that tick. A missing snapshot is
 * safe: the reference then goes stale and swaps ask for the PIN.
 *
 * Runs in the WhatsApp bot process only, like the reconciler.
 */

const { publicErrorMessage } = require('./sanitize');
const { bucketStart, readPoolReserves, verifiedPools } = require('./priceReference');
const { getDexConfig } = require('./dex');
const { LISTED_TOKENS } = require('./listedTokens');

const TICK_MS = 5 * 60 * 1000;
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * One pass: snapshot every verified pool into the current bucket.
 *
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   provider: import('ethers').Provider,
 *   chain: { id: string, chainId: number },
 *   now?: number,
 *   pools?: Array<{ token: string, pair: string }>,
 * }} deps
 * @returns {Promise<{ written: number, skipped: number }>}
 */
async function runSnapshotTick({ supabase, provider, chain, now = Date.now(), pools }) {
  const list = pools || verifiedPools(getDexConfig(chain.id), LISTED_TOKENS);
  const bucket = bucketStart(now);
  const rows = [];
  let skipped = 0;
  for (const pool of list) {
    try {
      const r = await readPoolReserves(provider, pool);
      if (r.reserveEth <= 0n || r.reserveToken <= 0n) {
        skipped += 1;
        continue;
      }
      rows.push({
        chain_id: chain.chainId,
        token: pool.token,
        pair: pool.pair,
        bucket,
        reserve_eth: r.reserveEth.toString(),
        reserve_token: r.reserveToken.toString(),
      });
    } catch (err) {
      skipped += 1;
      console.warn('[price snapshot] read:', pool.token, publicErrorMessage(err));
    }
  }
  if (rows.length) {
    const { error } = await supabase
      .from('token_price_snapshots')
      .upsert(rows, { onConflict: 'chain_id,token,bucket', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  return { written: rows.length, skipped };
}

/**
 * Delete snapshots older than two days.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} now
 */
async function pruneSnapshots(supabase, now) {
  const { error } = await supabase
    .from('token_price_snapshots')
    .delete()
    .lt('bucket', new Date(now - KEEP_MS).toISOString());
  if (error) throw new Error(error.message);
}

/**
 * Start the 5 minute timer. The first pass runs at once, so a fresh start
 * fills the current bucket without waiting.
 *
 * @param {Parameters<typeof runSnapshotTick>[0]} deps
 */
function startPriceSnapshots(deps) {
  let running = false;
  let lastPrune = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    const now = Date.now();
    try {
      await runSnapshotTick({ ...deps, now });
      if (now - lastPrune >= PRUNE_EVERY_MS) {
        await pruneSnapshots(deps.supabase, now);
        lastPrune = now;
      }
    } catch (err) {
      console.error('[price snapshot] tick:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { runSnapshotTick, pruneSnapshots, startPriceSnapshots, KEEP_MS };
