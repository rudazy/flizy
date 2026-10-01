/**
 * The limit order watcher.
 *
 * Orders are placed on the site (POST /api/swap/limit, behind the account
 * password) and stored in limit_orders. This loop, running in the bot process,
 * does the rest on each tick:
 *
 *   1. Orders past their deadline become expired.
 *   2. An order left in `filling` for more than FILLING_STALE_MS becomes failed,
 *      never open again: the process may have died after the swap was sent, and
 *      re-opening it could trade twice. The person checks History.
 *   3. Each open order is quoted. When the pool would return at least min_out,
 *      the order is claimed (open -> filling, in one conditional update, so two
 *      processes cannot both take it) and swapped with min_out as the on-chain
 *      minimum. A fill can therefore never land below the price that was set.
 *
 * The swap itself goes through executeSwapPlan, the same path a chat swap
 * takes: balance check, gator or EOA wallet, and the History row.
 */

const { ethers } = require('ethers');
const { getDexConfig, quoteSwap, resolveToken } = require('./dex');
const { executeSwapPlan } = require('./engine/executeSwap');
const { tryAccountTxLock, releaseAccountTxLock } = require('./accountTxLock');
const { publicErrorMessage } = require('./sanitize');

/** How often open orders are checked. */
const WATCH_INTERVAL_MS = 15000;

/** Orders quoted per tick. Oldest first, so none is starved. */
const ORDERS_PER_TICK = 25;

/** A claim older than this is treated as interrupted. Covers a slow tx.wait. */
const FILLING_STALE_MS = 10 * 60 * 1000;

/** Fits the table's 300-character limit with room to spare. */
function shortError(message) {
  return String(message || 'Swap failed.').slice(0, 280);
}

/**
 * Build the SWAP plan executeSwapPlan expects for one order.
 * @param {object} order a limit_orders row
 * @param {object} chain
 */
function planForOrder(order, chain) {
  const dex = getDexConfig(chain.id);
  const flz = resolveToken('FLZ', chain.id);
  const buy = order.side === 'buy';
  const amountIn = BigInt(order.amount_in);
  const minOut = BigInt(order.min_out);
  return {
    intent: 'SWAP',
    input: {
      side: order.side,
      amount: ethers.formatUnits(amountIn, 18),
      asset: buy ? 'ETH' : 'FLZ',
      tokenInLabel: buy ? 'ETH' : 'FLZ',
      tokenOutLabel: buy ? 'FLZ' : 'ETH',
      amountOut: ethers.formatUnits(minOut, 18),
      amountInWei: amountIn.toString(),
      amountOutMinWei: minOut.toString(),
      inIsNative: buy,
      outIsNative: !buy,
      tokenIn: buy ? null : flz,
      tokenOut: buy ? flz : null,
    },
    actor: { accountId: order.account_id, waSenderId: 'limit' },
    route: { kind: 'swap', chainId: chain.chainId, chainName: chain.name, routerAddress: dex.feeRouter },
  };
}

/**
 * One pass over the book. Every dependency is passed in so the test drives it
 * against a fake database and a scripted pool.
 *
 * @param {object} deps
 * @returns {Promise<{ expired: number, interrupted: number, filled: number, failed: number }>}
 */
async function runLimitOrderTick({
  supabase,
  provider,
  chain,
  now = Date.now(),
  quote = quoteSwap,
  executePlan = executeSwapPlan,
  lock = tryAccountTxLock,
  release = releaseAccountTxLock,
}) {
  const nowIso = new Date(now).toISOString();
  const counts = { expired: 0, interrupted: 0, filled: 0, failed: 0 };

  const expired = await supabase
    .from('limit_orders')
    .update({ status: 'expired', updated_at: nowIso })
    .eq('status', 'open')
    .lte('expires_at', nowIso)
    .select('id');
  if (expired.error) throw new Error(expired.error.message);
  counts.expired = (expired.data || []).length;

  const interrupted = await supabase
    .from('limit_orders')
    .update({
      status: 'failed',
      updated_at: nowIso,
      error: 'Interrupted while filling. Check History before placing it again.',
    })
    .eq('status', 'filling')
    .lt('updated_at', new Date(now - FILLING_STALE_MS).toISOString())
    .select('id');
  if (interrupted.error) throw new Error(interrupted.error.message);
  counts.interrupted = (interrupted.data || []).length;

  const open = await supabase
    .from('limit_orders')
    .select('id, account_id, side, amount_in, min_out, expires_at')
    .eq('status', 'open')
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(ORDERS_PER_TICK);
  if (open.error) throw new Error(open.error.message);

  const flz = resolveToken('FLZ', chain.id);
  for (const order of open.data || []) {
    const buy = order.side === 'buy';
    let reached = false;
    try {
      const q = await quote({
        provider,
        amountIn: BigInt(order.amount_in),
        tokenIn: buy ? null : flz,
        tokenOut: buy ? flz : null,
        chainKey: chain.id,
      });
      reached = q.amountOut >= BigInt(order.min_out);
    } catch (err) {
      console.warn(`[limit] quote ${order.id}:`, publicErrorMessage(err));
      continue;
    }
    if (!reached) continue;

    // Claim it. Only an order still open and in date moves, so a cancel that
    // landed a moment ago, or another process, wins and this one skips.
    const claim = await supabase
      .from('limit_orders')
      .update({ status: 'filling', updated_at: new Date(now).toISOString() })
      .eq('id', order.id)
      .eq('status', 'open')
      .gt('expires_at', nowIso)
      .select('id')
      .maybeSingle();
    if (claim.error || !claim.data) continue;

    const held = await lock(supabase, order.account_id, 'limit');
    if (!held.ok) {
      // Another payment from this account is in flight. Put it back for the
      // next tick rather than failing an order nobody did anything wrong with.
      await supabase
        .from('limit_orders')
        .update({ status: 'open', updated_at: new Date(now).toISOString() })
        .eq('id', order.id)
        .eq('status', 'filling');
      continue;
    }

    try {
      const result = await executePlan({ plan: planForOrder(order, chain), provider, chain });
      if (result && result.ok) {
        await supabase
          .from('limit_orders')
          .update({
            status: 'filled',
            filled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tx_hash: result.txHash || null,
          })
          .eq('id', order.id);
        counts.filled += 1;
      } else {
        await supabase
          .from('limit_orders')
          .update({
            status: 'failed',
            updated_at: new Date().toISOString(),
            error: shortError(result && result.error),
          })
          .eq('id', order.id);
        counts.failed += 1;
      }
    } catch (err) {
      await supabase
        .from('limit_orders')
        .update({ status: 'failed', updated_at: new Date().toISOString(), error: shortError(publicErrorMessage(err)) })
        .eq('id', order.id);
      counts.failed += 1;
    } finally {
      await release(supabase, order.account_id);
    }
  }
  return counts;
}

/**
 * Run the watcher on a timer. One tick at a time: a slow fill delays the next
 * pass instead of overlapping it.
 * @returns {() => void} stop function
 */
function startLimitOrderWatcher({ supabase, provider, chain, intervalMs = WATCH_INTERVAL_MS }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const c = await runLimitOrderTick({ supabase, provider, chain });
      if (c.filled || c.failed || c.interrupted) {
        console.log(`[limit] filled=${c.filled} failed=${c.failed} interrupted=${c.interrupted}`);
      }
    } catch (err) {
      console.warn('[limit] tick failed:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  runLimitOrderTick,
  startLimitOrderWatcher,
  planForOrder,
  FILLING_STALE_MS,
};
