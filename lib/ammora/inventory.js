/**
 * Ammora pool inventory, kept by the WhatsApp bot.
 *
 * The SDK's route client accepts only pools discovered from the chain with
 * their provenance (discoverAmmoraPools over the pinned factory's logs). The
 * first scan from the factory's start block takes minutes on the public RPC,
 * far too long for a site request, so this job scans incrementally and stores
 * what it finds in ammora_pools for the site and the bot to read:
 *
 *   1. discover new launch curves from the last scanned block to head minus
 *      the catalog's finality (12 blocks), and store them;
 *   2. read each new token's name, symbol and decimals from the token contract
 *      (never a metadata URL), capped in length;
 *   3. discover the concentrated or compounding pool a launch graduates to,
 *      from the same pinned deployment's factories, on its own cursor and at
 *      most GRADUATED_SCAN_BLOCKS per pass. Only the pool the launch's own
 *      curve names as its canonical pool is stored;
 *   4. flags from the Data API: a launch Ammora blacklisted is FLAGGED (a
 *      failure keeps the stored flags);
 *   5. launch status from each curve's own status() on chain;
 *   6. probe each launch with a tiny quote: tradable means the SDK would route
 *      it right now, on its curve or on the pool it graduated to, within the
 *      price impact cap. Every real quote checks again.
 *
 * Runs only with AMMORA_ENABLED on and the pinned venue attested.
 */

const { ethers } = require('ethers');
const { loadAmmoraSdk } = require('./sdk');
const { AMMORA_CHAIN_ID, VENUE, ammoraEnabled, launchTokens, impactTooHigh } = require('./venue');
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
/** Blocks the graduated-pool scan covers in one pass; the first backfill takes several passes. */
const GRADUATED_SCAN_BLOCKS = 1_000_000n;
/** Curve status() on chain, as ammora_pools stores it. Any other value keeps the stored status. */
const CURVE_STATUS = { 1: 'ACTIVE', 2: 'MIGRATION_READY', 3: 'MIGRATED' };
/** Status reads sent at once. */
const STATUS_BATCH = 10;

const ERC20 = new ethers.Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const CURVE = new ethers.Interface([
  'function status() view returns (uint8)',
  'function canonicalPool() view returns (address)',
]);

async function readCurve(provider, curve, fn) {
  return CURVE.decodeFunctionResult(fn, await provider.call({ to: curve, data: CURVE.encodeFunctionData(fn, []) }))[0];
}

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

/** Discover and store new launch curves. @returns {Promise<number>} curves stored */
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

/**
 * Discover the pools launches graduated to and store each launch's own one.
 * The scan never runs past the curve scan, so a launch is always stored
 * before its graduation is looked for. @returns {Promise<number>} pools stored
 */
async function discoverGraduatedPools({ supabase, provider, sdk, client }) {
  const { data: state, error: stateErr } = await supabase
    .from(SCAN_STATE)
    .select('scanned_to_block, graduated_scanned_to_block')
    .eq('chain_id', AMMORA_CHAIN_ID)
    .maybeSingle();
  if (stateErr) throw new Error(stateErr.message);
  if (!state) return 0;
  const done = state.graduated_scanned_to_block == null ? BigInt(VENUE.dbcFactoryStartBlock) - 1n : BigInt(state.graduated_scanned_to_block);
  const from = done + 1n;
  const curvesTo = BigInt(state.scanned_to_block);
  const to = from + GRADUATED_SCAN_BLOCKS - 1n < curvesTo ? from + GRADUATED_SCAN_BLOCKS - 1n : curvesTo;
  if (to < from) return 0;
  const deployment = {
    ...sdk.giwaSepoliaAutoRoute,
    factories: sdk.giwaSepoliaAutoRoute.factories.filter((f) => f.kind === 'concentrated' || f.kind === 'compounding'),
  };
  const found = await sdk.discoverAmmoraPools({
    clients: [client],
    deployment,
    fromBlock: from,
    toBlock: to,
    initialWindow: LOG_WINDOW,
    maximumWindow: LOG_WINDOW,
  });
  let stored = 0;
  if (found.length > 0) {
    const { data: curves, error } = await supabase.from(POOLS).select('pool, base_token').eq('chain_id', AMMORA_CHAIN_ID).eq('model', 'dbc');
    if (error) throw new Error(error.message);
    const curveFor = new Map((curves || []).map((r) => [r.base_token, r.pool]));
    const weth = VENUE.contracts.wrappedNative.address.toLowerCase();
    for (const p of found) {
      const curve = curveFor.get(p.baseToken.toLowerCase());
      // Anyone can open a pool on these factories: only the one a stored
      // launch's curve names as its canonical pool, against WETH, is stored.
      if (!curve || p.quoteToken.toLowerCase() !== weth) continue;
      let canonical;
      try {
        canonical = String(await readCurve(provider, curve, 'canonicalPool')).toLowerCase();
      } catch (err) {
        console.warn(`[ammora] canonical pool for ${curve}:`, publicErrorMessage(err));
        continue;
      }
      if (canonical !== p.pool.toLowerCase()) continue;
      const { error: upErr } = await supabase.from(POOLS).upsert(
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
        },
        { onConflict: 'pool' }
      );
      if (upErr) throw new Error(upErr.message);
      stored += 1;
    }
  }
  const { error } = await supabase
    .from(SCAN_STATE)
    .update({ graduated_scanned_to_block: String(to), updated_at: new Date().toISOString() })
    .eq('chain_id', AMMORA_CHAIN_ID);
  if (error) throw new Error(error.message);
  return stored;
}

/**
 * Flags from the Data API: a launch Ammora blacklisted is FLAGGED, and a flag
 * Ammora lifted is cleared for the chain status to fill. A failure leaves the
 * stored flags. Launch status itself comes from the chain (refreshChainStatuses).
 */
async function refreshFlags({ supabase, sdk, dataApiUrl }) {
  const api = new sdk.AmmoraDataApiClient(dataApiUrl);
  const flagged = new Set();
  const listed = new Set();
  let cursor;
  let pages = 0;
  do {
    const signal = AbortSignal.timeout(DATA_API_TIMEOUT_MS);
    const page = await api.getLaunches({ chainId: BigInt(AMMORA_CHAIN_ID), cursor, signal });
    for (const l of page.items) {
      const address = String(l.address).toLowerCase();
      listed.add(address);
      if (l.blacklisted) flagged.add(address);
    }
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 30);
  const { data, error } = await supabase.from(POOLS).select('pool, model, base_token, launch_status').eq('chain_id', AMMORA_CHAIN_ID);
  if (error) throw new Error(error.message);
  for (const row of launchTokens(data || [])) {
    let next;
    if (flagged.has(row.base_token)) next = 'FLAGGED';
    else if (row.launch_status === 'FLAGGED' && listed.has(row.base_token)) next = null;
    else continue;
    if (next !== row.launch_status) {
      const { error: upErr } = await supabase.from(POOLS).update({ launch_status: next }).eq('pool', row.pool);
      if (upErr) throw new Error(upErr.message);
    }
  }
}

/** Launch status from each curve's status() on chain. A flagged launch keeps its flag. */
async function refreshChainStatuses({ supabase, provider }) {
  const { data, error } = await supabase.from(POOLS).select('pool, model, launch_status').eq('chain_id', AMMORA_CHAIN_ID);
  if (error) throw new Error(error.message);
  const rows = launchTokens(data || []).filter((r) => r.launch_status !== 'FLAGGED');
  for (let i = 0; i < rows.length; i += STATUS_BATCH) {
    const batch = rows.slice(i, i + STATUS_BATCH);
    const statuses = await Promise.all(
      batch.map((r) => readCurve(provider, r.pool, 'status').then((s) => CURVE_STATUS[Number(s)] || null, () => null))
    );
    for (let j = 0; j < batch.length; j += 1) {
      const next = statuses[j];
      if (!next || next === batch[j].launch_status) continue;
      const { error: upErr } = await supabase.from(POOLS).update({ launch_status: next }).eq('pool', batch[j].pool);
      if (upErr) throw new Error(upErr.message);
    }
  }
}

/** Probe each launch with a tiny quote; tradable when the SDK would route it. */
async function refreshTradable({ supabase, now }) {
  resetRouteClient();
  const { routes, inventory } = await getRouteClient(supabase, { now });
  const graduated = new Set(inventory.filter((t) => t.model !== 'dbc').map((t) => t.baseToken.toLowerCase()));
  for (const t of launchTokens(inventory)) {
    let tradable = false;
    // A flagged launch is never quoted, nor a migrated one with no graduated
    // pool stored: each pass is bounded by the launches that can route.
    const routable = t.launchStatus !== 'FLAGGED' && (t.launchStatus !== 'MIGRATED' || graduated.has(t.baseToken.toLowerCase()));
    if (routable) {
      try {
        const quote = await quoteAmmora(routes, { tokenIn: null, tokenOut: t.baseToken, amountIn: PROBE_WEI, slippageBps: 100 });
        // A pool so thin that even the probe is refused for price impact is not tradable.
        tradable = !impactTooHigh(quote);
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
  const out = { discovered: 0, graduated: 0, statuses: false, chainStatuses: false, probed: false };
  try {
    out.discovered = await discoverNewPools({ supabase, provider, sdk, client });
  } catch (err) {
    console.error('[ammora] discovery:', publicErrorMessage(err));
  }
  try {
    out.graduated = await discoverGraduatedPools({ supabase, provider, sdk, client });
  } catch (err) {
    console.error('[ammora] graduated pools:', publicErrorMessage(err));
  }
  try {
    await refreshFlags({ supabase, sdk, dataApiUrl: apiUrl });
    out.statuses = true;
  } catch (err) {
    console.warn('[ammora] Data API flags (kept the last known):', publicErrorMessage(err));
  }
  try {
    await refreshChainStatuses({ supabase, provider });
    out.chainStatuses = true;
  } catch (err) {
    console.error('[ammora] launch status:', publicErrorMessage(err));
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
