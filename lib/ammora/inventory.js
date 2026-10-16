/**
 * Ammora pool inventory, kept by the WhatsApp bot.
 *
 * The SDK's route client accepts only pools discovered from the chain with
 * their provenance (discoverAmmoraPools over the pinned factory's logs). The
 * first scan from the factory's start block takes minutes on the public RPC,
 * far too long for a site request, so this job scans incrementally and stores
 * what it finds in ammora_pools for the site and the bot to read:
 *
 *   1. discover new pools from the last scanned block to head minus the
 *      catalog's finality (12 blocks), and store them;
 *   2. read each new token's name, symbol and decimals from the token contract
 *      (never a metadata URL), capped in length;
 *   3. refresh launch status from the Data API (a failure keeps the last one);
 *   4. probe each pool with a tiny quote: tradable means the SDK would route
 *      it right now (registered and executable). Every real quote checks again.
 *
 * Runs only with AMMORA_ENABLED on and the pinned venue attested.
 */

const { ethers } = require('ethers');
const { loadAmmoraSdk } = require('./sdk');
const { AMMORA_CHAIN_ID, VENUE, ammoraEnabled } = require('./venue');
const { ensureAttested } = require('./attest');
const { viemClient, getRouteClient, quoteAmmora, resetRouteClient } = require('./routes');
const { publicErrorMessage } = require('../sanitize');

const POOLS = 'ammora_pools';
const SCAN_STATE = 'ammora_scan_state';
const TICK_MS = 10 * 60_000;
const FINALITY_BLOCKS = 12n;
const LOG_WINDOW = 10_000n;
const PROBE_WEI = 10n ** 14n;
const DATA_API_TIMEOUT_MS = 10_000;
const DEFAULT_DATA_API = 'https://ammora-giwa-sepolia-data.fly.dev';
// The launch states ammora_pools accepts (its check constraint).
const LAUNCH_STATUSES = new Set(['PENDING', 'ACTIVE', 'MIGRATION_READY', 'MIGRATED', 'FLAGGED']);

const ERC20 = new ethers.Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** Token text is chosen by whoever launched it: no NULs, capped in length. */
function capText(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, max);
}

async function tokenMeta(provider, token) {
  const read = async (fn) => ERC20.decodeFunctionResult(fn, await provider.call({ to: token, data: ERC20.encodeFunctionData(fn, []) }))[0];
  const [name, symbol, decimals] = await Promise.all([read('name'), read('symbol'), read('decimals')]);
  return { token_name: capText(name, 64), token_symbol: capText(symbol, 32), token_decimals: Number(decimals) };
}

async function scannedTo(supabase) {
  const { data, error } = await supabase.from(SCAN_STATE).select('scanned_to_block').eq('chain_id', AMMORA_CHAIN_ID).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? BigInt(data.scanned_to_block) : BigInt(VENUE.dbcFactoryStartBlock) - 1n;
}

/** Discover and store new pools. @returns {Promise<number>} pools stored */
async function discoverNewPools({ supabase, provider, sdk, client }) {
  const from = (await scannedTo(supabase)) + 1n;
  const head = await client.getBlockNumber();
  const to = head - FINALITY_BLOCKS;
  if (to < from) return 0;
  const deployment = { ...sdk.giwaSepoliaAutoRoute, factories: sdk.giwaSepoliaAutoRoute.factories.filter((f) => f.kind === 'dbc') };
  const found = await sdk.discoverAmmoraPools({
    clients: [client],
    deployment,
    fromBlock: from,
    toBlock: to,
    initialWindow: LOG_WINDOW,
    maximumWindow: LOG_WINDOW,
  });
  let stored = 0;
  for (const p of found) {
    let meta = { token_name: null, token_symbol: null, token_decimals: null };
    try {
      meta = await tokenMeta(provider, p.baseToken);
    } catch (err) {
      console.warn(`[ammora] token fields for ${p.baseToken}:`, publicErrorMessage(err));
    }
    const { error } = await supabase.from(POOLS).upsert(
      {
        pool: p.pool.toLowerCase(),
        chain_id: AMMORA_CHAIN_ID,
        model: p.model,
        base_token: p.baseToken.toLowerCase(),
        quote_token: p.quoteToken.toLowerCase(),
        factory: p.factory.toLowerCase(),
        factory_id: p.factoryId,
        creation_block: String(p.creationBlock),
        creation_tx: p.creationTransaction,
        creation_log_index: p.creationLogIndex,
        runtime_code_hash: p.runtimeCodeHash,
        verified_at_block: String(p.verifiedAtBlock),
        ...meta,
      },
      { onConflict: 'pool' }
    );
    if (error) throw new Error(error.message);
    stored += 1;
  }
  const { error } = await supabase
    .from(SCAN_STATE)
    .upsert({ chain_id: AMMORA_CHAIN_ID, scanned_to_block: String(to), updated_at: new Date().toISOString() }, { onConflict: 'chain_id' });
  if (error) throw new Error(error.message);
  return stored;
}

/** Launch status from the Data API. A failure leaves the stored statuses. */
async function refreshStatuses({ supabase, sdk, dataApiUrl }) {
  const api = new sdk.AmmoraDataApiClient(dataApiUrl);
  const status = new Map();
  let cursor;
  let pages = 0;
  do {
    const signal = AbortSignal.timeout(DATA_API_TIMEOUT_MS);
    const page = await api.getLaunches({ chainId: BigInt(AMMORA_CHAIN_ID), cursor, signal });
    for (const l of page.items) {
      const next = l.blacklisted ? 'FLAGGED' : String(l.status);
      // The Data API is a third party: an unknown state is skipped, not stored.
      if (LAUNCH_STATUSES.has(next)) status.set(String(l.address).toLowerCase(), next);
    }
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 30);
  const { data, error } = await supabase.from(POOLS).select('pool, base_token, launch_status').eq('chain_id', AMMORA_CHAIN_ID);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    const next = status.get(row.base_token) || null;
    if (next && next !== row.launch_status) {
      const { error: upErr } = await supabase.from(POOLS).update({ launch_status: next }).eq('pool', row.pool);
      if (upErr) throw new Error(upErr.message);
    }
  }
}

/** Probe each pool with a tiny quote; tradable when the SDK would route it. */
async function refreshTradable({ supabase, now }) {
  resetRouteClient();
  const { routes, inventory } = await getRouteClient(supabase, { now });
  for (const t of inventory) {
    let tradable = false;
    // A migrated or flagged launch never routes, so it is not quoted: that
    // keeps each pass bounded by the live curves, not by every launch ever.
    if (t.launchStatus !== 'FLAGGED' && t.launchStatus !== 'MIGRATED') {
      try {
        await quoteAmmora(routes, { tokenIn: null, tokenOut: t.baseToken, amountIn: PROBE_WEI, slippageBps: 100 });
        tradable = true;
      } catch {
        tradable = false;
      }
    }
    const { error: upErr } = await supabase.from(POOLS).update({ tradable, tradable_checked_at: new Date(now).toISOString() }).eq('pool', t.pool);
    if (upErr) throw new Error(upErr.message);
  }
}

/** One pass. Each step fails on its own; none of them stops the others. */
async function runInventoryTick({ supabase, provider, now = Date.now(), dataApiUrl }) {
  if (!ammoraEnabled()) return { skipped: 'off' };
  const attested = await ensureAttested(provider, { now });
  if (!attested.ok) return { skipped: 'not attested' };
  const sdk = await loadAmmoraSdk();
  const apiUrl = dataApiUrl || process.env.AMMORA_DATA_API_URL || DEFAULT_DATA_API;
  const client = viemClient();
  const out = { discovered: 0, statuses: false, probed: false };
  try {
    out.discovered = await discoverNewPools({ supabase, provider, sdk, client });
  } catch (err) {
    console.error('[ammora] discovery:', publicErrorMessage(err));
  }
  try {
    await refreshStatuses({ supabase, sdk, dataApiUrl: apiUrl });
    out.statuses = true;
  } catch (err) {
    console.warn('[ammora] launch status (kept the last known):', publicErrorMessage(err));
  }
  try {
    await refreshTradable({ supabase, now });
    out.probed = true;
  } catch (err) {
    console.error('[ammora] tradable probe:', publicErrorMessage(err));
  }
  return out;
}

/** Run on a timer, one pass at a time. The first pass starts right away. */
function startInventory({ supabase, provider, dataApiUrl }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await runInventoryTick({ supabase, provider, dataApiUrl });
      console.log('[ammora] inventory', out);
    } catch (err) {
      console.error('[ammora] inventory:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { runInventoryTick, startInventory, capText };
