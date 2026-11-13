/**
 * Ammora launches after their curve: graduated pools, launch status from the
 * chain, and quotes that report a price impact.
 *
 * Covers: the inventory storing only the pool a launch's own curve names as
 * canonical, on its own cursor that never passes the curve scan; launch status
 * read from each curve's status(), with the Data API adding flags only; the
 * probe quoting a graduated launch; one entry per launch in chat, the site
 * swap, Explore and the wallet; the fee view for a fee taken in the token;
 * and the refusal of a quote with too high a price impact. Everything outside
 * Flizy is scripted: nothing here touches a network.
 *
 * Run: node --test test/ammoraGraduated.test.js
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const venue = require('../lib/ammora/venue');
const attest = require('../lib/ammora/attest');
const sdkMod = require('../lib/ammora/sdk');
const routesMod = require('../lib/ammora/routes');

const CHAIN = venue.AMMORA_CHAIN_ID;
const WETH = venue.VENUE.contracts.wrappedNative.address.toLowerCase();
const START = BigInt(venue.VENUE.dbcFactoryStartBlock);

// Launch tokens and their curves.
const A = '0xa000000000000000000000000000000000000001';
const B = '0xb000000000000000000000000000000000000002';
const C = '0xc000000000000000000000000000000000000003';
const curveOf = (token) => `0x${token.slice(2, 4)}${'c'.repeat(38)}`;
// The pool A graduated to, a second pool someone opened for A, and two others.
const GA = '0x1000000000000000000000000000000000000aaa';
const GX = '0x1000000000000000000000000000000000000bbb';
const GU = '0x1000000000000000000000000000000000000ccc';
const GW = '0x1000000000000000000000000000000000000ddd';
const STRANGER_TOKEN = '0xdead00000000000000000000000000000000beef';

const CODE = '0x6001';
const CLEAN_CONFIG = {
  ...venue.VENUE,
  contracts: Object.fromEntries(
    Object.entries(venue.VENUE.contracts).map(([role, c]) => [role, { ...c, codeHash: ethers.keccak256(CODE) }])
  ),
};

const CURVE = new ethers.Interface([
  'function status() view returns (uint8)',
  'function canonicalPool() view returns (address)',
]);

/** A chain: pinned code everywhere, and each curve's status() and canonicalPool(). */
function chainProvider({ statuses = {}, canonical = {} } = {}) {
  const calls = [];
  return {
    calls,
    async getNetwork() {
      return { chainId: BigInt(CHAIN) };
    },
    async getCode() {
      return CODE;
    },
    async getBlockNumber() {
      return 100;
    },
    async call({ to, data }) {
      const at = String(to).toLowerCase();
      const selector = String(data).slice(0, 10);
      calls.push([at, selector]);
      if (selector === CURVE.getFunction('status').selector) {
        if (!(at in statuses)) throw new Error('execution reverted');
        return CURVE.encodeFunctionResult('status', [statuses[at]]);
      }
      if (selector === CURVE.getFunction('canonicalPool').selector) {
        return CURVE.encodeFunctionResult('canonicalPool', [canonical[at] || ethers.ZeroAddress]);
      }
      throw new Error('unexpected call');
    },
  };
}

function curveRow(token, symbol, extra = {}) {
  return {
    pool: curveOf(token),
    chain_id: CHAIN,
    model: 'dbc',
    base_token: token,
    quote_token: WETH,
    factory: venue.VENUE.contracts.dbcFactory.address.toLowerCase(),
    factory_id: '0x01',
    creation_block: '36220001',
    creation_tx: `0x${'ab'.repeat(32)}`,
    creation_log_index: 0,
    runtime_code_hash: `0x${'cd'.repeat(32)}`,
    verified_at_block: '36220010',
    token_name: `${symbol} token`,
    token_symbol: symbol,
    token_decimals: 18,
    launch_status: 'ACTIVE',
    tradable: true,
    ...extra,
  };
}

function graduatedRow(pool, token, model = 'concentrated') {
  return {
    ...curveRow(token, 'X'),
    pool,
    model,
    factory: '0x9ebd78f3839996014238728b4c9c2f2a4e6759cb',
    token_name: null,
    token_symbol: null,
    token_decimals: null,
    launch_status: null,
    tradable: false,
  };
}

/** An in-memory Supabase for ammora_pools and ammora_scan_state that applies writes. */
function memorySupabase({ pools = [], scan = null } = {}) {
  const db = { ammora_pools: pools.map((r) => ({ ...r })), ammora_scan_state: scan ? [{ chain_id: CHAIN, ...scan }] : [] };
  const writes = [];
  return {
    db,
    writes,
    from(table) {
      const q = { op: 'select', filters: [], value: null, onConflict: null };
      const matching = () => db[table].filter((r) => q.filters.every(([c, v]) => String(r[c]) === String(v)));
      const run = () => {
        if (q.op === 'update') {
          for (const r of matching()) Object.assign(r, q.value);
          return { data: null, error: null };
        }
        if (q.op === 'upsert') {
          const hit = db[table].find((r) => r[q.onConflict] === q.value[q.onConflict]);
          if (hit) Object.assign(hit, q.value);
          else db[table].push({ ...q.value });
          return { data: null, error: null };
        }
        return { data: matching(), error: null };
      };
      const b = {
        select: () => b,
        order: () => b,
        range: () => b,
        eq(col, v) {
          q.filters.push([col, v]);
          return b;
        },
        update(v) {
          q.op = 'update';
          q.value = v;
          writes.push({ table, op: 'update', value: v, filters: q.filters });
          return b;
        },
        upsert(v, opts) {
          q.op = 'upsert';
          q.value = v;
          q.onConflict = opts.onConflict;
          writes.push({ table, op: 'upsert', value: v });
          return b;
        },
        maybeSingle: async () => {
          const r = run();
          return { data: (r.data && r.data[0]) || null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

const pool = (address, model, baseToken, quoteToken = WETH) => ({
  model,
  pool: address,
  baseToken,
  quoteToken,
  factory: '0x9eBD78f3839996014238728b4c9C2f2A4e6759Cb',
  factoryId: `${model}-v4`,
  creationBlock: 36_250_000n,
  creationTransaction: `0x${'ef'.repeat(32)}`,
  creationLogIndex: 3,
  runtimeCodeHash: `0x${'aa'.repeat(32)}`,
  verifiedAtBlock: 36_250_012n,
});

/** A scripted SDK: discovery by factory kind, the Data API, and a route client. */
function scriptedSdk({ graduated = [], launches = [], dataApiDown = false, routable = new Set(), quote } = {}) {
  const log = { discover: [], creates: [], quotes: [] };
  const routes = {
    async quoteExactIn(p) {
      log.quotes.push(p.tokenOut.toLowerCase());
      if (quote) return quote(p);
      if (!routable.has(p.tokenOut.toLowerCase())) throw Object.assign(new Error('no route'), { code: 'AMMORA_SDK_ROUTE_UNAVAILABLE' });
      return { amountIn: p.amountIn, expectedAmountOut: 1n, minimumAmountOut: 1n, priceImpactBps: null, fees: { total: 0n, token: WETH }, hops: [{}] };
    },
    async prepareExactIn() {
      throw new Error('not used');
    },
  };
  return {
    log,
    routes,
    sdk: {
      giwaSepoliaAutoRoute: { factories: ['dbc', 'concentrated', 'compounding', 'almm'].map((kind) => ({ kind })) },
      giwaSepoliaAutoRouteCatalog: {},
      giwaSepoliaAutoRouteDeploymentCatalog: {},
      giwaSepoliaAutoRoutePoolProfiles: {},
      async discoverAmmoraPools(args) {
        const kinds = args.deployment.factories.map((f) => f.kind);
        log.discover.push({ kinds, fromBlock: args.fromBlock, toBlock: args.toBlock });
        return kinds.includes('concentrated') ? graduated : [];
      },
      AmmoraDataApiClient: class {
        async getLaunches() {
          if (dataApiDown) throw new Error('Data API down');
          return { items: launches, nextCursor: null };
        }
      },
      AmmoraRouteClient: {
        async create(args) {
          log.creates.push(args.aggregationPools.map((p) => [p.pool, p.model]));
          return routes;
        },
      },
    },
  };
}

const savedFlag = process.env.AMMORA_ENABLED;
function enable() {
  process.env.AMMORA_ENABLED = 'true';
}

after(() => {
  if (savedFlag === undefined) delete process.env.AMMORA_ENABLED;
  else process.env.AMMORA_ENABLED = savedFlag;
  sdkMod.setAmmoraSdkForTests(null);
  routesMod.setViemClientForTests(null);
  attest.resetAttestation();
});

async function attestWith(provider) {
  attest.resetAttestation();
  const res = await attest.ensureAttested(provider, { config: CLEAN_CONFIG });
  assert.equal(res.ok, true);
}

describe('launch tokens, fee view and price impact (both sides)', () => {
  let web;
  before(async () => {
    web = await import('../web/lib/ammora/venue.ts');
  });
  const sides = () => [venue, web];

  it('a launch and the pool it graduated to are one token', () => {
    const rows = [{ model: 'dbc', baseToken: A }, { model: 'concentrated', baseToken: A }, { model: 'compounding', baseToken: C }, { model: 'dbc', baseToken: C }];
    for (const m of sides()) assert.deepEqual(m.launchTokens(rows), [rows[0], rows[3]]);
  });

  it('a graduated sell pays its fee in the token: the rate is from the input, the fee is shown in ETH', () => {
    // Figures from a real quote through a graduated concentrated pool.
    const quote = {
      amountIn: 9_872_006_480_083n,
      expectedAmountOut: 35_800_764_535_970n,
      priceImpactBps: null,
      hops: [{ model: 'concentrated' }],
      fees: { total: 98_720_064_801n, token: A, lp: null, protocol: null, creator: null },
    };
    for (const m of sides()) {
      const v = m.ammoraFeeView(quote, { nativeIn: false });
      assert.equal(v.label, 'Ammora pool fee');
      assert.equal(v.rateBps, 100);
      // One percent of what went in, at this trade's price: about 1/99 of the ETH out.
      assert.ok(v.feeWei > quote.expectedAmountOut / 100n && v.feeWei < quote.expectedAmountOut / 98n, String(v.feeWei));
    }
  });

  it('a graduated buy pays its fee in WETH from the input, as a curve does', () => {
    const quote = { amountIn: 10n ** 14n, expectedAmountOut: 19_744_012_960_166n, priceImpactBps: 2592n, hops: [{ model: 'compounding' }], fees: { total: 10n ** 12n, token: WETH } };
    for (const m of sides()) {
      const v = m.ammoraFeeView(quote, { nativeIn: true });
      assert.equal(v.label, 'Ammora pool fee');
      assert.equal(v.rateBps, 100);
      assert.equal(v.feeWei, 10n ** 12n);
      assert.equal(v.priceImpact, '25.92%');
    }
  });

  it('a fee taken in the token on a buy is shown in ETH at the trade price', () => {
    const quote = { amountIn: 1_000_000n, expectedAmountOut: 990n, priceImpactBps: null, fees: { total: 10n, token: A } };
    for (const m of sides()) {
      const v = m.ammoraFeeView(quote, { nativeIn: true });
      assert.equal(v.rateBps, 100);
      assert.equal(v.feeWei, 10_000n);
      assert.equal(v.label, 'Ammora curve fee');
    }
  });

  it('an impact of 100% or more is shown as over 100%, and over 50% is refused', () => {
    for (const m of sides()) {
      const v = m.ammoraFeeView({ amountIn: 1n, expectedAmountOut: 1n, priceImpactBps: 122_682_048n, fees: { total: 0n, token: WETH } }, { nativeIn: true });
      assert.equal(v.priceImpact, 'over 100%');
      assert.equal(m.MAX_PRICE_IMPACT_BPS, 5000);
      assert.equal(m.impactTooHigh({ priceImpactBps: null }), false);
      assert.equal(m.impactTooHigh({ priceImpactBps: 5000n }), false);
      assert.equal(m.impactTooHigh({ priceImpactBps: 5001n }), true);
    }
  });
});

describe('inventory: graduated pools and chain status', () => {
  const { runInventoryTick } = require('../lib/ammora/inventory');
  const HEAD = 36_300_000n;
  const curvesTo = String(HEAD - 12n);
  const launches = () => [curveRow(A, 'GRAD', { launch_status: null, tradable: false }), curveRow(B, 'BAD'), curveRow(C, 'LIVE', { launch_status: null, tradable: false })];
  const chain = () =>
    chainProvider({
      statuses: { [curveOf(A)]: 3, [curveOf(B)]: 1, [curveOf(C)]: 1 },
      canonical: { [curveOf(A)]: GA },
    });

  beforeEach(() => {
    enable();
    routesMod.resetRouteClient();
    routesMod.setViemClientForTests({ getBlockNumber: async () => HEAD });
  });

  it('stores only the canonical pool of a stored launch, against WETH, and moves its own cursor', async () => {
    const provider = chain();
    await attestWith(provider);
    const fake = scriptedSdk({
      graduated: [pool(GA, 'concentrated', A), pool(GX, 'concentrated', A), pool(GU, 'compounding', STRANGER_TOKEN), pool(GW, 'compounding', C, STRANGER_TOKEN)],
      launches: [{ address: B, blacklisted: true, status: 'ACTIVE' }, { address: A, blacklisted: false, status: 'ACTIVE' }],
      routable: new Set([A, C]),
    });
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const supabase = memorySupabase({ pools: launches(), scan: { scanned_to_block: curvesTo, graduated_scanned_to_block: null } });
    const out = await runInventoryTick({ supabase, provider, dataApiUrl: 'http://127.0.0.1:9' });
    assert.deepEqual(out, { discovered: 0, graduated: 1, statuses: true, chainStatuses: true, probed: true });

    // Graduated discovery: the concentrated and compounding factories only,
    // from the factory's start block to the curve scan's block.
    const grad = fake.log.discover.find((d) => d.kinds.includes('concentrated'));
    assert.deepEqual(grad.kinds, ['concentrated', 'compounding']);
    assert.equal(grad.fromBlock, START);
    assert.equal(grad.toBlock, HEAD - 12n);
    assert.equal(supabase.db.ammora_scan_state[0].graduated_scanned_to_block, curvesTo);

    const byPool = new Map(supabase.db.ammora_pools.map((r) => [r.pool, r]));
    assert.equal(byPool.has(GA), true);
    for (const skipped of [GX, GU, GW]) assert.equal(byPool.has(skipped), false, skipped);
    assert.equal(byPool.get(GA).model, 'concentrated');
    assert.equal(byPool.get(GA).base_token, A);
    assert.equal(byPool.get(GA).token_symbol, undefined);

    // Status: A graduated on chain, C trades, B is flagged by Ammora.
    assert.equal(byPool.get(curveOf(A)).launch_status, 'MIGRATED');
    assert.equal(byPool.get(curveOf(C)).launch_status, 'ACTIVE');
    assert.equal(byPool.get(curveOf(B)).launch_status, 'FLAGGED');

    // The probe routes through the graduated pool and never quotes B.
    assert.deepEqual(fake.log.quotes, [A, C]);
    assert.equal(byPool.get(curveOf(A)).tradable, true);
    assert.equal(byPool.get(curveOf(B)).tradable, false);
    assert.equal(byPool.get(curveOf(C)).tradable, true);
    assert.deepEqual(fake.log.creates.at(-1).find(([p]) => p === GA), [GA, 'concentrated']);
  });

  it('never scans past the curve scan, and at most its window per pass', async () => {
    const provider = chain();
    await attestWith(provider);
    const fake = scriptedSdk();
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const far = String(START + 5_000_000n);
    routesMod.setViemClientForTests({ getBlockNumber: async () => START + 5_000_012n });
    const supabase = memorySupabase({ pools: launches(), scan: { scanned_to_block: far, graduated_scanned_to_block: null } });
    await runInventoryTick({ supabase, provider, dataApiUrl: 'http://127.0.0.1:9' });
    const grad = fake.log.discover.find((d) => d.kinds.includes('concentrated'));
    assert.equal(grad.fromBlock, START);
    assert.equal(grad.toBlock, START + 999_999n);
    assert.equal(supabase.db.ammora_scan_state[0].graduated_scanned_to_block, String(START + 999_999n));

    // Caught up: nothing is scanned until the curve scan moves on.
    fake.log.discover.length = 0;
    const caughtUp = memorySupabase({ pools: launches(), scan: { scanned_to_block: far, graduated_scanned_to_block: far } });
    await runInventoryTick({ supabase: caughtUp, provider, dataApiUrl: 'http://127.0.0.1:9' });
    assert.equal(fake.log.discover.some((d) => d.kinds.includes('concentrated')), false);
  });

  it('Data API down: a flagged launch stays flagged and is not quoted; the others still get chain status', async () => {
    const provider = chain();
    await attestWith(provider);
    const fake = scriptedSdk({ dataApiDown: true, routable: new Set([A, B, C]) });
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const rows = launches();
    rows[1].launch_status = 'FLAGGED';
    const supabase = memorySupabase({ pools: rows, scan: { scanned_to_block: curvesTo, graduated_scanned_to_block: curvesTo } });
    const out = await runInventoryTick({ supabase, provider, dataApiUrl: 'http://127.0.0.1:9' });
    assert.equal(out.statuses, false);
    assert.equal(out.chainStatuses, true);
    const byPool = new Map(supabase.db.ammora_pools.map((r) => [r.pool, r]));
    assert.equal(byPool.get(curveOf(B)).launch_status, 'FLAGGED');
    assert.equal(byPool.get(curveOf(A)).launch_status, 'MIGRATED');
    assert.equal(byPool.get(curveOf(C)).launch_status, 'ACTIVE');
    // A graduated with no pool stored: nothing to route through, so not quoted.
    assert.deepEqual(fake.log.quotes, [C]);
    assert.equal(byPool.get(curveOf(A)).tradable, false);
  });

  it('a flag Ammora lifted is cleared and the chain status fills it', async () => {
    const provider = chain();
    await attestWith(provider);
    sdkMod.setAmmoraSdkForTests(scriptedSdk({ launches: [{ address: B, blacklisted: false, status: 'ACTIVE' }] }).sdk);
    const rows = launches();
    rows[1].launch_status = 'FLAGGED';
    const supabase = memorySupabase({ pools: rows, scan: { scanned_to_block: curvesTo, graduated_scanned_to_block: curvesTo } });
    await runInventoryTick({ supabase, provider, dataApiUrl: 'http://127.0.0.1:9' });
    assert.equal(supabase.db.ammora_pools.find((r) => r.pool === curveOf(B)).launch_status, 'ACTIVE');
  });

  it('a launch whose probe quote is over the price impact cap is not tradable', async () => {
    const provider = chain();
    await attestWith(provider);
    const quote = (p) => ({
      amountIn: p.amountIn,
      expectedAmountOut: 1n,
      minimumAmountOut: 1n,
      priceImpactBps: p.tokenOut.toLowerCase() === A ? 1_226_920n : 125n,
      fees: { total: 0n, token: WETH },
      hops: [{ model: 'compounding' }],
    });
    sdkMod.setAmmoraSdkForTests(scriptedSdk({ dataApiDown: true, quote }).sdk);
    const rows = [...launches(), graduatedRow(GA, A, 'compounding')];
    const supabase = memorySupabase({ pools: rows, scan: { scanned_to_block: curvesTo, graduated_scanned_to_block: curvesTo } });
    await runInventoryTick({ supabase, provider, dataApiUrl: 'http://127.0.0.1:9' });
    const byPool = new Map(supabase.db.ammora_pools.map((r) => [r.pool, r]));
    assert.equal(byPool.get(curveOf(A)).tradable, false);
    assert.equal(byPool.get(curveOf(C)).tradable, true);
  });

  it('an unknown or unreadable curve status keeps the stored one', async () => {
    const provider = chainProvider({ statuses: { [curveOf(A)]: 0 } });
    await attestWith(provider);
    sdkMod.setAmmoraSdkForTests(scriptedSdk({ dataApiDown: true }).sdk);
    const rows = [curveRow(A, 'GRAD', { launch_status: 'ACTIVE' }), curveRow(C, 'LIVE', { launch_status: 'MIGRATION_READY' })];
    const supabase = memorySupabase({ pools: rows, scan: { scanned_to_block: curvesTo, graduated_scanned_to_block: curvesTo } });
    await runInventoryTick({ supabase, provider, dataApiUrl: 'http://127.0.0.1:9' });
    assert.deepEqual(supabase.db.ammora_pools.map((r) => r.launch_status), ['ACTIVE', 'MIGRATION_READY']);
    assert.equal(supabase.writes.some((w) => w.value && 'launch_status' in w.value), false);
  });
});

describe('one token per launch on every surface', () => {
  // The graduated pool's row comes first, so a lookup that did not keep to
  // launches would find it before the curve.
  const rows = () => [
    graduatedRow(GA, A),
    curveRow(A, 'GRAD', { launch_status: 'MIGRATED', tradable: true }),
    curveRow(B, 'BAD', { launch_status: 'ACTIVE', tradable: true }),
    curveRow(C, 'LIVE', { launch_status: 'ACTIVE', tradable: true }),
  ];
  const provider = chainProvider();

  beforeEach(async () => {
    enable();
    routesMod.resetRouteClient();
    routesMod.setViemClientForTests({ getBlockNumber: async () => 36_300_000n });
    await attestWith(provider);
  });

  it('chat resolves a graduated launch by symbol and by address, not as ambiguous', async () => {
    const chat = require('../lib/ammora/chat');
    const fake = scriptedSdk({ routable: new Set([A]) });
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const supabase = memorySupabase({ pools: rows() });
    for (const raw of ['GRAD', 'grad', A]) {
      const r = await chat.routeForChat({ supabase, provider, raw });
      assert.equal(r.use, 'ammora', raw);
      assert.equal(r.token.pool, curveOf(A));
    }
    // The route client gets the graduated pool too.
    assert.deepEqual(fake.log.creates.at(-1).find(([p]) => p === GA), [GA, 'concentrated']);
  });

  it('chat refuses a quote over the price impact cap, and shows a reported impact', async () => {
    const chat = require('../lib/ammora/chat');
    const engine = require('../lib/engine');
    const GATOR = '0x9999999999999999999999999999999999999999';
    const quoteWith = (bps) => (p) => ({
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: p.amountIn,
      expectedAmountOut: 5_000_000_000n,
      minimumAmountOut: 4_950_000_000n,
      priceImpactBps: bps,
      fees: { total: p.amountIn / 100n, token: WETH },
      hops: [{ model: 'concentrated' }],
    });
    const plan = (bps) => {
      const fake = scriptedSdk({ quote: quoteWith(bps) });
      return chat.buildAmmoraChatPlan({
        token: { baseToken: A, symbol: 'GRAD', decimals: 18 },
        routes: fake.routes,
        side: 'buy',
        amountStr: '0.01',
        amountMode: 'in',
        actor: { accountId: 'acc-1', channel: 'telegram', externalId: '123456' },
        siteAcc: { id: 'acc-1', agent_wallet_address: GATOR },
        chain: { id: 'giwa_sepolia', chainId: CHAIN, name: 'GIWA Sepolia', nativeSymbol: 'ETH' },
        gator: GATOR,
        createSwapIntent: engine.createSwapIntent,
        evaluateSwapPolicy: (i) => engine.evaluateSwapPolicy(i, { requireUnlock: false }),
        buildSwapPlan: engine.buildSwapPlan,
        formatEth: (v) => String(v),
        slippageBps: 100,
      });
    };
    const refused = await plan(6000n);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /more than half/);
    const shown = await plan(2592n);
    assert.equal(shown.ok, true);
    assert.equal(shown.plan.input.ammora.priceImpact, '25.92%');
    assert.equal(shown.plan.input.ammora.feeLabel, 'Ammora pool fee');
  });

  describe('site', () => {
    let catalog;
    let site;
    let webAttest;
    let webRoutes;
    before(async () => {
      process.env.WALLET_DERIVATION_SECRET = process.env.WALLET_DERIVATION_SECRET || 'x'.repeat(40);
      catalog = await import('../web/lib/ammora/catalog.ts');
      site = await import('../web/lib/ammora/siteSwap.ts');
      webAttest = await import('../web/lib/ammora/attest.ts');
      webRoutes = await import('../web/lib/ammora/routes.ts');
    });
    beforeEach(async () => {
      catalog.resetCatalogCache();
      webRoutes.resetRouteClient();
      webRoutes.setViemClientForTests({ getBlockNumber: async () => 36_300_000n });
      webAttest.resetAttestation();
      assert.equal((await webAttest.ensureAttested(provider, { config: CLEAN_CONFIG })).ok, true);
    });
    after(() => {
      webRoutes.setViemClientForTests(null);
      webRoutes.setAmmoraSdkForTests(null);
    });

    // The Data API lists A as active (stale) and B as blacklisted.
    const fetcher = async (url) => ({
      ok: true,
      json: async () =>
        String(url).includes('/v1/tokens?')
          ? { items: [{ address: A, status: 'ACTIVE' }, { address: B, status: 'ACTIVE', blacklisted: true }, { address: C, status: 'ACTIVE' }], nextCursor: null }
          : { items: [] },
    });

    it('Explore lists each launch once, with the chain status, and a live flag on top', async () => {
      const out = await catalog.listAmmoraTokens(memorySupabase({ pools: rows() }), provider, { fetcher });
      assert.equal(out.unavailable, false);
      assert.deepEqual(
        out.tokens.map((t) => [t.address, t.status, t.tradable]),
        [
          [A, 'migrated', true],
          [C, 'active', true],
        ]
      );
    });

    it('the wallet reads one balance per launch, never the graduated pool row', async () => {
      const list = await catalog.ammoraHoldingCandidates(memorySupabase({ pools: rows() }));
      assert.deepEqual(list.map((t) => t.address), [A, B, C]);
    });

    it('the site quote resolves a graduated launch and refuses too high a price impact', async () => {
      const quote = (bps) => (p) => ({
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        amountIn: p.amountIn,
        expectedAmountOut: 5_000_000_000n,
        minimumAmountOut: 4_950_000_000n,
        priceImpactBps: bps,
        fees: { total: p.amountIn / 100n, token: WETH },
        hops: [{ model: 'concentrated' }],
      });
      webRoutes.setAmmoraSdkForTests(scriptedSdk({ quote: quote(2592n) }).sdk);
      const ok = await site.ammoraSiteQuote(memorySupabase({ pools: rows() }), provider, { side: 'buy', token: A, amount: '0.01' });
      assert.equal(ok.priceImpact, '25.92%');
      assert.equal(ok.fee.label, 'Ammora pool fee');
      webRoutes.resetRouteClient();
      webRoutes.setAmmoraSdkForTests(scriptedSdk({ quote: quote(6000n) }).sdk);
      await assert.rejects(site.ammoraSiteQuote(memorySupabase({ pools: rows() }), provider, { side: 'buy', token: 'GRAD', amount: '0.01' }), {
        message: site.AMMORA_ROUTE_REFUSALS.impact,
      });
    });
  });
});
