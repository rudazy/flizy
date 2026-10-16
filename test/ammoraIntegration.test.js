/**
 * The Ammora venue end to end, with everything outside Flizy scripted: the SDK
 * (route client, quotes, prepared swaps), the chain (code reads, allowance
 * reads), the Data API and the database. Nothing here touches a network.
 *
 * Covers: the pinned-code check turning the venue off; AMMORA_ENABLED off
 * meaning no SDK load, no chain read and no database read; the inventory's
 * text caps and Data API failures; the Explore catalog's empty state and
 * sanitizing; chat buy, sell and price; approvals through Flizy's executor
 * (never the SDK's execute()); and the site swap's refusals.
 *
 * Run: node --test test/ammoraIntegration.test.js
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const venue = require('../lib/ammora/venue');
const attest = require('../lib/ammora/attest');
const sdkMod = require('../lib/ammora/sdk');
const routesMod = require('../lib/ammora/routes');

const ROUTER = venue.VENUE.contracts.aggregationRouter.address;
const NATIVE = venue.NATIVE;
const TOKEN = '0xc23220d34534ae3c8bbe231db911b7e662743b6e';
const SLEEPY = '0x5555555555555555555555555555555555555555';
const FAKE_FLZ = '0x1111111111111111111111111111111111111111';
const GATOR = '0x9999999999999999999999999999999999999999';
const ROUTER_FN = new ethers.Interface([
  'function swapExactInput((uint256 chainId, (address pool, address tokenIn, address tokenOut, bytes venueParams)[] hops, uint256 amountIn, uint256 minimumAmountOut, address recipient, uint256 deadline, address referrer, uint16 maximumIntegratorFeeBps, bool unwrapNative) p) payable',
]);

// A chain where every pinned contract has this code, and a config pinning it.
const CODE = '0x6001';
const CLEAN_CONFIG = {
  ...venue.VENUE,
  contracts: Object.fromEntries(
    Object.entries(venue.VENUE.contracts).map(([role, c]) => [role, { ...c, codeHash: ethers.keccak256(CODE) }])
  ),
};

function fakeProvider({ chainId = venue.AMMORA_CHAIN_ID, code = CODE, allowance = 0n } = {}) {
  const calls = { getCode: 0, getNetwork: 0, call: 0 };
  return {
    calls,
    async getNetwork() {
      calls.getNetwork += 1;
      return { chainId: BigInt(chainId) };
    },
    async getCode() {
      calls.getCode += 1;
      return code;
    },
    async call() {
      calls.call += 1;
      return ethers.toBeHex(allowance, 32);
    },
    async getBlockNumber() {
      return 100;
    },
  };
}

function poolRow(base, symbol, extra = {}) {
  return {
    pool: `0x${base.slice(2, 10)}${'0'.repeat(32)}`,
    chain_id: venue.AMMORA_CHAIN_ID,
    model: 'dbc',
    base_token: base,
    quote_token: venue.VENUE.contracts.wrappedNative.address.toLowerCase(),
    factory: venue.VENUE.contracts.dbcFactory.address.toLowerCase(),
    factory_id: '0x01',
    creation_block: '36220001',
    creation_tx: `0x${'ab'.repeat(32)}`,
    creation_log_index: 0,
    runtime_code_hash: `0x${'cd'.repeat(32)}`,
    verified_at_block: '36220010',
    token_name: `${symbol} token`,
    token_symbol: symbol,
    token_decimals: 9,
    launch_status: 'ACTIVE',
    tradable: true,
    ...extra,
  };
}

const ROWS = [
  poolRow(TOKEN, 'AIV4C'),
  poolRow(FAKE_FLZ, 'FLZ'),
  poolRow(SLEEPY, 'SLEEPY', { tradable: false, launch_status: 'MIGRATED' }),
];

/** A Supabase client that serves ammora_pools and records writes. */
function fakeSupabase(rows = ROWS, { failPools = false } = {}) {
  const writes = [];
  let reads = 0;
  return {
    writes,
    get reads() {
      return reads;
    },
    from(table) {
      const q = { table, op: 'select', value: null, filters: [] };
      const result = () => {
        if (q.op === 'select' && table === 'ammora_pools') {
          reads += 1;
          return failPools ? { data: null, error: { message: 'down' } } : { data: rows, error: null };
        }
        if (q.op === 'insert') return { data: { id: 'row-1' }, error: null };
        return { data: null, error: null };
      };
      const b = {
        select() {
          return b;
        },
        eq(col, v) {
          q.filters.push([col, v]);
          return b;
        },
        order() {
          return b;
        },
        range() {
          return b;
        },
        insert(v) {
          q.op = 'insert';
          q.value = v;
          writes.push(q);
          return b;
        },
        update(v) {
          q.op = 'update';
          q.value = v;
          writes.push(q);
          return b;
        },
        upsert(v) {
          q.op = 'upsert';
          q.value = v;
          writes.push(q);
          return b;
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then(resolve, reject) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

/** A scripted SDK. quote() and prepare() can be overridden per test. */
function fakeSdk(over = {}) {
  const log = { create: 0, quotes: [], prepares: [], execute: 0 };
  const quote = over.quote || ((p) => {
    const nativeIn = p.tokenIn.toLowerCase() === NATIVE.toLowerCase();
    const out = nativeIn ? 5_000_000_000n : 900_000_000_000_000n;
    const fee = nativeIn ? (p.amountIn * 125n) / 10_000n : 11_392_405_063_291n;
    return {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: p.amountIn,
      expectedAmountOut: out,
      minimumAmountOut: (out * 99n) / 100n,
      priceImpactBps: null,
      fees: { total: fee, token: venue.VENUE.contracts.wrappedNative.address },
      hops: [{}],
      router: ROUTER,
    };
  });
  // What the real SDK builds (one hop through the token's pool, paid to the
  // requested recipient, no referrer), so Flizy's calldata check sees a real call.
  const prepare = over.prepare || ((q, opts) => {
    const nativeIn = q.tokenIn.toLowerCase() === NATIVE.toLowerCase();
    const token = nativeIn ? q.tokenOut : q.tokenIn;
    const weth = venue.VENUE.contracts.wrappedNative.address;
    const data = ROUTER_FN.encodeFunctionData('swapExactInput', [
      {
        chainId: BigInt(venue.AMMORA_CHAIN_ID),
        hops: [{ pool: poolRow(token.toLowerCase(), 'X').pool, tokenIn: nativeIn ? weth : token, tokenOut: nativeIn ? token : weth, venueParams: '0x' }],
        amountIn: q.amountIn,
        minimumAmountOut: q.minimumAmountOut,
        recipient: opts.recipient,
        deadline: 2_000_000_000n,
        referrer: ethers.ZeroAddress,
        maximumIntegratorFeeBps: 0,
        unwrapNative: !nativeIn,
      },
    ]);
    return {
      transaction: { to: ROUTER, data, value: nativeIn ? q.amountIn : 0n },
      approvalRequirements: nativeIn ? [] : [{ token: q.tokenIn, spender: ROUTER, amount: q.amountIn, resetToZero: false }],
      quote: q,
    };
  });
  const routes = {
    async quoteExactIn(p) {
      log.quotes.push(p);
      if (over.quoteError) throw over.quoteError;
      return quote(p);
    },
    async prepareExactIn(q, opts) {
      log.prepares.push({ q, opts });
      return prepare(q, opts);
    },
  };
  return {
    log,
    routes,
    sdk: {
      AmmoraRouteClient: {
        async create(args) {
          log.create += 1;
          log.createArgs = args;
          return routes;
        },
      },
      giwaSepoliaAutoRouteCatalog: {},
      giwaSepoliaAutoRouteDeploymentCatalog: {},
      giwaSepoliaAutoRoutePoolProfiles: {},
      AmmoraDataApiClient: class {
        async getLaunches() {
          throw new Error('Data API down');
        }
      },
      // Flizy must never call this: every swap goes through its own executor.
      async execute() {
        log.execute += 1;
        throw new Error('SDK execute() must not be called');
      },
    },
  };
}

const stubClient = { async getBlockNumber() { return 36_300_000n; } };
const savedFlag = process.env.AMMORA_ENABLED;

function enable() {
  process.env.AMMORA_ENABLED = 'true';
}
function disable() {
  delete process.env.AMMORA_ENABLED;
}
async function attestClean() {
  attest.resetAttestation();
  const res = await attest.ensureAttested(fakeProvider(), { config: CLEAN_CONFIG });
  assert.equal(res.ok, true);
}

after(() => {
  if (savedFlag === undefined) delete process.env.AMMORA_ENABLED;
  else process.env.AMMORA_ENABLED = savedFlag;
  sdkMod.setAmmoraSdkForTests(null);
  routesMod.setViemClientForTests(null);
  attest.resetAttestation();
});

beforeEach(() => {
  routesMod.resetRouteClient();
  routesMod.setViemClientForTests(stubClient);
});

describe('the pinned-code check', () => {
  it('passes only when every pinned contract has the pinned code on the right chain', async () => {
    assert.equal((await attest.checkPinnedCode(fakeProvider(), CLEAN_CONFIG)).ok, true);
    const wrongChain = await attest.checkPinnedCode(fakeProvider({ chainId: 1 }), CLEAN_CONFIG);
    assert.equal(wrongChain.ok, false);
    assert.match(wrongChain.reason, /wrong chain/);
  });

  it('a code hash mismatch turns the venue off, and the Ammora router leaves the allowlist', async () => {
    enable();
    attest.resetAttestation();
    const res = await attest.ensureAttested(fakeProvider({ code: '0x6002' }), { config: CLEAN_CONFIG });
    assert.equal(res.ok, false);
    assert.equal(res.mismatches.length, Object.keys(CLEAN_CONFIG.contracts).length);
    const dex = require('../lib/dex');
    assert.equal(dex.isAllowedSwapRouter(ROUTER), false);

    await attestClean();
    assert.equal(dex.isAllowedSwapRouter(ROUTER), true);
    // Flag off: the router is not allowed even with a clean check.
    disable();
    assert.equal(dex.isAllowedSwapRouter(ROUTER), false);
  });

  it('a mismatch on the real pinned config (unexpected code) is reported per role', async () => {
    const res = await attest.checkPinnedCode(fakeProvider(), venue.VENUE);
    assert.equal(res.ok, false);
    assert.deepEqual(res.mismatches.map((m) => m.role).sort(), Object.keys(venue.VENUE.contracts).sort());
  });
});

describe('AMMORA_ENABLED off changes nothing', () => {
  before(() => disable());

  it('chat routing: no SDK, no chain read, no database read', async () => {
    const chat = require('../lib/ammora/chat');
    const fake = fakeSdk();
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const provider = fakeProvider();
    const supabase = fakeSupabase();
    const out = await chat.routeForChat({ supabase, provider, raw: TOKEN });
    assert.deepEqual(out, { use: 'flizy' });
    assert.equal(provider.calls.getCode + provider.calls.getNetwork, 0);
    assert.equal(supabase.reads, 0);
    assert.equal(fake.log.create, 0);
  });

  it('bot start: nothing loaded, read or scheduled', async () => {
    const { startAmmora } = require('../lib/ammora/boot');
    const provider = fakeProvider();
    const out = await startAmmora({ supabase: fakeSupabase(), provider, inventory: true });
    assert.deepEqual(out, { started: false });
    assert.equal(provider.calls.getCode + provider.calls.getNetwork, 0);
  });

  it('inventory tick: skipped before any read', async () => {
    const { runInventoryTick } = require('../lib/ammora/inventory');
    const provider = fakeProvider();
    const supabase = fakeSupabase();
    assert.deepEqual(await runInventoryTick({ supabase, provider }), { skipped: 'off' });
    assert.equal(provider.calls.getCode, 0);
    assert.equal(supabase.reads + supabase.writes.length, 0);
  });

  it('the swap policy refuses the Ammora router', async () => {
    const { createSwapIntent, evaluateSwapPolicy } = require('../lib/engine');
    await attestClean();
    const intent = createSwapIntent({
      actor: { accountId: 'acc-1', channel: 'telegram', externalId: '123456' },
      side: 'buy',
      amountIn: '0.001',
      tokenInLabel: 'ETH',
      tokenOutLabel: 'AIV4C',
      tokenIn: null,
      tokenOut: TOKEN,
      routerAddress: ROUTER,
      chainId: 'giwa_sepolia',
      slippageBps: 100,
    });
    const policy = await evaluateSwapPolicy(intent, { requireUnlock: false });
    assert.equal(policy.decision, 'DENY');
    assert.equal(policy.reason, 'router_not_allowlisted');
  });

  it('the site routes and UI check the flags first', () => {
    const fs = require('node:fs');
    const read = (f) => fs.readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
    assert.match(read('web/app/api/ammora/tokens/route.ts'), /if \(!ammoraEnabled\(\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/);
    assert.match(read('web/app/api/swap/quote/route.ts'), /get\('venue'\) === 'ammora'\) \{\s*if \(!ammoraEnabled\(\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/);
    assert.match(read('web/app/api/swap/execute/route.ts'), /async function ammoraSwap[\s\S]{0,300}if \(!ammoraEnabled\(\)\)/);
    assert.match(read('web/components/AmmoraTokens.tsx'), /if \(!enabled\) return;[\s\S]*if \(!enabled\) return null;/);
    assert.match(read('web/app/dashboard/swap/page.tsx'), /ammoraUiEnabled\(\) && /);
  });
});

describe('inventory', () => {
  it('caps launcher-chosen text and strips NULs', () => {
    const { capText } = require('../lib/ammora/inventory');
    assert.equal(capText('AB\u0000C', 32), 'ABC');
    assert.equal(capText('x'.repeat(100), 64).length, 64);
    assert.equal(capText(null, 8), '');
  });

  it('a Data API failure keeps the stored statuses and the other steps still run', async () => {
    enable();
    await attestClean();
    const { runInventoryTick } = require('../lib/ammora/inventory');
    const fake = fakeSdk();
    sdkMod.setAmmoraSdkForTests({ ...fake.sdk, giwaSepoliaAutoRoute: { factories: [] }, discoverAmmoraPools: async () => [] });
    const supabase = fakeSupabase();
    const out = await runInventoryTick({ supabase, provider: fakeProvider(), dataApiUrl: 'http://127.0.0.1:9' });
    assert.equal(out.statuses, false);
    assert.equal(out.probed, true);
    assert.equal(supabase.writes.some((w) => w.value && 'launch_status' in w.value), false);
    disable();
  });

  it('reads the whole inventory in pages, past the 1,000-row response cap', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => poolRow(`0x${i.toString(16).padStart(40, '0')}`, `T${i}`));
    const ranges = [];
    const paged = {
      from() {
        let lo = 0;
        let hi = 0;
        const b = {
          select: () => b,
          eq: () => b,
          order: () => b,
          range(a, z) {
            lo = a;
            hi = z;
            ranges.push([a, z]);
            return b;
          },
          then: (res, rej) => Promise.resolve({ data: all.slice(lo, Math.min(hi + 1, lo + 1000)), error: null }).then(res, rej),
        };
        return b;
      },
    };
    for (const load of [routesMod.loadInventory, (await import('../web/lib/ammora/routes.ts')).loadInventory]) {
      ranges.length = 0;
      const inv = await load(paged);
      assert.equal(inv.length, 1500);
      assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
    }
  });

  it('skips when the pinned code does not match', async () => {
    enable();
    attest.resetAttestation();
    const { runInventoryTick } = require('../lib/ammora/inventory');
    const supabase = fakeSupabase();
    const out = await runInventoryTick({ supabase, provider: fakeProvider({ code: '0x6002' }) });
    assert.deepEqual(out, { skipped: 'not attested' });
    assert.equal(supabase.reads + supabase.writes.length, 0);
    disable();
  });
});

describe('chat: buy, sell and price with a scripted SDK', () => {
  let chat;
  let engine;
  let fake;
  before(async () => {
    chat = require('../lib/ammora/chat');
    engine = require('../lib/engine');
  });
  beforeEach(async () => {
    enable();
    await attestClean();
    fake = fakeSdk();
    sdkMod.setAmmoraSdkForTests(fake.sdk);
  });

  const chain = { id: 'giwa_sepolia', chainId: venue.AMMORA_CHAIN_ID, name: 'GIWA Sepolia', nativeSymbol: 'ETH' };
  const plan = (side, amountStr, token, amountMode = 'in') =>
    chat.buildAmmoraChatPlan({
      token,
      routes: fake.routes,
      side,
      amountStr,
      amountMode,
      actor: { accountId: 'acc-1', channel: 'telegram', externalId: '123456' },
      siteAcc: { id: 'acc-1', agent_wallet_address: GATOR },
      chain,
      gator: GATOR,
      createSwapIntent: engine.createSwapIntent,
      evaluateSwapPolicy: (i) => engine.evaluateSwapPolicy(i, { requireUnlock: false }),
      buildSwapPlan: engine.buildSwapPlan,
      formatEth: (v) => String(v),
      slippageBps: 100,
    });

  it('routes an Ammora token by address and by its unique symbol', async () => {
    const supabase = fakeSupabase();
    const byAddr = await chat.routeForChat({ supabase, provider: fakeProvider(), raw: TOKEN });
    assert.equal(byAddr.use, 'ammora');
    assert.equal(byAddr.token.baseToken, TOKEN);
    const bySym = await chat.routeForChat({ supabase, provider: fakeProvider(), raw: 'aiv4c' });
    assert.equal(bySym.use, 'ammora');
  });

  it('a Flizy symbol stays on Flizy even when an Ammora token uses it', async () => {
    const out = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: 'FLZ' });
    assert.deepEqual(out, { use: 'flizy' });
    // Decided from the stored inventory: no route client was built.
    assert.equal(fake.log.create, 0);
    // The colliding token is still reachable by its contract.
    const byAddr = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: FAKE_FLZ });
    assert.equal(byAddr.use, 'ammora');
  });

  it('a route client the SDK cannot build is a clean refusal for an Ammora token only', async () => {
    const broken = fakeSdk();
    broken.sdk.AmmoraRouteClient.create = async () => {
      throw Object.assign(new Error('atomic multi-hop runtime verification failed'), { code: 'AMMORA_SDK_UNVERIFIED_DEPLOYMENT' });
    };
    sdkMod.setAmmoraSdkForTests(broken.sdk);
    const out = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    assert.deepEqual(out, { use: 'refuse', message: chat.REFUSAL.unavailable });
    assert.deepEqual(await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: 'FLZ' }), { use: 'flizy' });
  });

  it('a token Ammora will not route right now is refused, not sent to Flizy', async () => {
    const out = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: SLEEPY });
    assert.equal(out.use, 'refuse');
    assert.equal(out.message, chat.REFUSAL.not_tradable);
  });

  it('buy: an Ammora plan with the label, contract, fee, minimum and no Flizy fee', async () => {
    const { token } = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    const built = await plan('buy', '0.001', token);
    assert.equal(built.ok, true, built.message);
    assert.equal(built.plan.route.venue, 'ammora');
    assert.equal(built.plan.input.ammora.token, TOKEN);
    const preview = chat.formatAmmoraPlanPreview(built.plan, 10, (a) => a);
    assert.match(preview, /Swap plan \(Ammora\)/);
    assert.match(preview, /AIV4C \(0xc232\.\.\.3b6e, Ammora\)/);
    assert.match(preview, new RegExp(`Contract: +${TOKEN}`));
    assert.match(preview, /Ammora curve fee: .* ETH \(1\.25%\)/);
    assert.match(preview, /Price impact: unavailable from Ammora/);
    assert.match(preview, /Flizy fee: +none on Ammora swaps/);
    assert.equal(fake.log.quotes[0].tokenIn, NATIVE);
    assert.equal(fake.log.quotes[0].tokenOut, TOKEN);
  });

  it('sell: quoted token to native', async () => {
    const { token } = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    const built = await plan('sell', '1000', token);
    assert.equal(built.ok, true, built.message);
    assert.equal(fake.log.quotes[0].tokenIn, TOKEN);
    assert.equal(fake.log.quotes[0].tokenOut, NATIVE);
    assert.equal(fake.log.quotes[0].amountIn, 1000n * 10n ** 9n);
    assert.equal(built.plan.input.inIsNative, false);
  });

  it('exact-out buys are refused (Ammora quotes exact input only)', async () => {
    const { token } = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    assert.equal((await plan('buy', '100', token, 'out')).message, chat.REFUSAL.exact_out);
  });

  it('a non-finalized curve (SDK refusal) is refused at quote time', async () => {
    const { token } = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    fake = fakeSdk({ quoteError: Object.assign(new Error('x'), { code: 'AMMORA_SDK_UNVERIFIED_DEPLOYMENT' }) });
    const built = await plan('buy', '0.001', token);
    assert.equal(built.ok, false);
    assert.equal(built.message, chat.REFUSAL.not_tradable);
  });

  it('price', async () => {
    const venueHit = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    const text = await chat.ammoraPriceText(venueHit);
    assert.match(text, /AIV4C \(0xc232\.\.\.3b6e, Ammora\) price/);
    assert.match(text, /Price impact unavailable from Ammora/);
    assert.match(text, new RegExp(`Contract: ${TOKEN}`));
  });
});

describe('execution goes through Flizy\'s executor', () => {
  let gx;
  let saved;
  let sent;
  before(() => {
    gx = require('../lib/gatorExecute');
    saved = { executeGatorCall: gx.executeGatorCall, executeApprovalCall: gx.executeApprovalCall, readAtLeast: gx.readAtLeast };
  });
  beforeEach(() => {
    sent = [];
    gx.executeApprovalCall = async (a) => {
      sent.push({ kind: 'approve', amount: BigInt(`0x${a.data.slice(74)}`), target: a.target });
      return { txHash: '0xa' };
    };
    gx.executeGatorCall = async (a) => {
      sent.push({ kind: 'swap', target: a.target, value: a.value });
      if (a.onBroadcast) await a.onBroadcast(`0x${'1'.repeat(64)}`);
      return { txHash: `0x${'1'.repeat(64)}` };
    };
    gx.readAtLeast = async (provider, _min, read) => read('latest');
  });
  after(() => Object.assign(gx, saved));

  const prepared = (resetToZero = false) => ({
    transaction: { to: ROUTER, data: '0xabcdef', value: 0n },
    approvalRequirements: [{ token: TOKEN, spender: ROUTER, amount: 1000n, resetToZero }],
  });

  it('no allowance: one exact approval, then the swap', async () => {
    const { executeAmmoraSwap } = require('../lib/ammora/execute');
    await executeAmmoraSwap({ accountId: 'a', provider: fakeProvider({ allowance: 0n }), chainId: 1, gator: GATOR, prepared: prepared() });
    assert.deepEqual(sent.map((s) => s.kind), ['approve', 'swap']);
    assert.equal(sent[0].amount, 1000n);
  });

  it('an existing allowance: zero first, then the exact amount, never unlimited', async () => {
    const { executeAmmoraSwap } = require('../lib/ammora/execute');
    await executeAmmoraSwap({ accountId: 'a', provider: fakeProvider({ allowance: 5n }), chainId: 1, gator: GATOR, prepared: prepared() });
    assert.deepEqual(sent.map((s) => s.amount ?? s.kind), [0n, 1000n, 'swap']);
    assert.ok(sent.every((s) => s.kind !== 'approve' || s.amount !== ethers.MaxUint256));
  });

  it('the exact allowance already there: no approval', async () => {
    const { executeAmmoraSwap } = require('../lib/ammora/execute');
    await executeAmmoraSwap({ accountId: 'a', provider: fakeProvider({ allowance: 1000n }), chainId: 1, gator: GATOR, prepared: prepared() });
    assert.deepEqual(sent.map((s) => s.kind), ['swap']);
  });

  it('a chat sell runs end to end on the executor and records the hash; the SDK never sends', async () => {
    enable();
    await attestClean();
    const fake = fakeSdk();
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const chat = require('../lib/ammora/chat');
    const engine = require('../lib/engine');
    const hit = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    const built = await chat.buildAmmoraChatPlan({
      token: hit.token,
      routes: hit.routes,
      side: 'sell',
      amountStr: '1',
      amountMode: 'in',
      actor: { accountId: 'acc-1', channel: 'telegram', externalId: '123456' },
      siteAcc: { id: 'acc-1', agent_wallet_address: GATOR },
      chain: { id: 'giwa_sepolia', chainId: venue.AMMORA_CHAIN_ID, name: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      gator: GATOR,
      createSwapIntent: engine.createSwapIntent,
      evaluateSwapPolicy: (i) => engine.evaluateSwapPolicy(i, { requireUnlock: false }),
      buildSwapPlan: engine.buildSwapPlan,
      formatEth: String,
      slippageBps: 100,
    });
    assert.equal(built.ok, true, built.message);
    const recorded = [];
    const receipts = [];
    const res = await chat.executeAmmoraPlan({
      plan: built.plan,
      provider: fakeProvider({ allowance: 0n }),
      chain: { chainId: venue.AMMORA_CHAIN_ID },
      supabase: fakeSupabase(),
      gator: GATOR,
      recordBroadcast: async (id, hash) => {
        recorded.push(hash);
        return id || 'row-1';
      },
      transferRow: { id: 'row-1' },
      rowPayload: {},
      logReceipt: async (id, r) => receipts.push(r),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(sent.map((s) => s.kind), ['approve', 'swap']);
    assert.equal(sent[1].target, ROUTER);
    assert.equal(recorded.length, 1);
    assert.equal(receipts[0].ok, true);
    assert.equal(fake.log.execute, 0);
    assert.equal(fake.log.prepares[0].opts.executionMode, 'account-abstraction');
  });

  it('a price move past the reviewed minimum sends nothing and closes the row', async () => {
    enable();
    await attestClean();
    const fake = fakeSdk();
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const chat = require('../lib/ammora/chat');
    const engine = require('../lib/engine');
    const hit = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    const built = await chat.buildAmmoraChatPlan({
      token: hit.token, routes: hit.routes, side: 'buy', amountStr: '0.001', amountMode: 'in',
      actor: { accountId: 'acc-1', channel: 'telegram', externalId: '123456' }, siteAcc: { id: 'acc-1', agent_wallet_address: GATOR },
      chain: { id: 'giwa_sepolia', chainId: venue.AMMORA_CHAIN_ID, name: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      gator: GATOR, createSwapIntent: engine.createSwapIntent,
      evaluateSwapPolicy: (i) => engine.evaluateSwapPolicy(i, { requireUnlock: false }),
      buildSwapPlan: engine.buildSwapPlan, formatEth: String, slippageBps: 100,
    });
    built.plan.input.amountOutMinWei = (10n ** 30n).toString();
    const receipts = [];
    const res = await chat.executeAmmoraPlan({
      plan: built.plan, provider: fakeProvider(), chain: { chainId: venue.AMMORA_CHAIN_ID }, supabase: fakeSupabase(),
      gator: GATOR, recordBroadcast: async () => 'row-1', transferRow: { id: 'row-1' }, rowPayload: {},
      logReceipt: async (id, r) => receipts.push(r),
    });
    assert.deepEqual(res, { ok: false, submitted: false, error: chat.REFUSAL.price_moved });
    assert.equal(sent.length, 0);
    assert.equal(receipts[0].ok, false);
  });

  it('a pinned-router call that pays a stranger is refused, nothing approved or sent', async () => {
    enable();
    await attestClean();
    // Honest for planning, then the prepared call names another recipient.
    const fake = fakeSdk();
    const realPrepare = fake.routes.prepareExactIn;
    fake.routes.prepareExactIn = async (q, opts) => realPrepare(q, { ...opts, recipient: STRANGER_ADDR });
    sdkMod.setAmmoraSdkForTests(fake.sdk);
    const chat = require('../lib/ammora/chat');
    const engine = require('../lib/engine');
    const hit = await chat.routeForChat({ supabase: fakeSupabase(), provider: fakeProvider(), raw: TOKEN });
    const built = await chat.buildAmmoraChatPlan({
      token: hit.token, routes: hit.routes, side: 'sell', amountStr: '1', amountMode: 'in',
      actor: { accountId: 'acc-1', channel: 'telegram', externalId: '123456' }, siteAcc: { id: 'acc-1', agent_wallet_address: GATOR },
      chain: { id: 'giwa_sepolia', chainId: venue.AMMORA_CHAIN_ID, name: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      gator: GATOR, createSwapIntent: engine.createSwapIntent,
      evaluateSwapPolicy: (i) => engine.evaluateSwapPolicy(i, { requireUnlock: false }),
      buildSwapPlan: engine.buildSwapPlan, formatEth: String, slippageBps: 100,
    });
    const receipts = [];
    const res = await chat.executeAmmoraPlan({
      plan: built.plan, provider: fakeProvider(), chain: { chainId: venue.AMMORA_CHAIN_ID }, supabase: fakeSupabase(),
      gator: GATOR, recordBroadcast: async () => 'row-1', transferRow: { id: 'row-1' }, rowPayload: {},
      logReceipt: async (id, r) => receipts.push(r),
    });
    assert.deepEqual(res, { ok: false, submitted: false, error: chat.REFUSAL.policy });
    assert.equal(sent.length, 0);
    assert.equal(receipts[0].ok, false);
  });
});

const STRANGER_ADDR = '0x2222222222222222222222222222222222222222';

describe('site: Explore catalog and swap refusals', () => {
  let catalog;
  let site;
  let webAttest;
  let webRoutes;
  let webVenue;
  before(async () => {
    process.env.WALLET_DERIVATION_SECRET = process.env.WALLET_DERIVATION_SECRET || 'x'.repeat(40);
    catalog = await import('../web/lib/ammora/catalog.ts');
    site = await import('../web/lib/ammora/siteSwap.ts');
    webAttest = await import('../web/lib/ammora/attest.ts');
    webRoutes = await import('../web/lib/ammora/routes.ts');
    webVenue = await import('../web/lib/ammora/venue.ts');
  });
  beforeEach(async () => {
    enable();
    catalog.resetCatalogCache();
    webRoutes.resetRouteClient();
    webRoutes.setViemClientForTests(stubClient);
    webAttest.resetAttestation();
    const ok = await webAttest.ensureAttested(fakeProvider(), { config: CLEAN_CONFIG });
    assert.equal(ok.ok, true);
  });
  after(() => {
    webRoutes.setViemClientForTests(null);
    webRoutes.setAmmoraSdkForTests(null);
    disable();
  });

  const okFetch = (items) => async () => ({ ok: true, json: async () => ({ items, nextCursor: null }) });

  it('Data API down: a clean empty state, not an error', async () => {
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    const out = await catalog.listAmmoraTokens(fakeSupabase(), fakeProvider(), { fetcher: down });
    assert.deepEqual(out, { tokens: [], unavailable: true });
    catalog.resetCatalogCache();
    const bad = async () => ({ ok: false, json: async () => ({}) });
    assert.deepEqual(await catalog.listAmmoraTokens(fakeSupabase(), fakeProvider(), { fetcher: bad }), { tokens: [], unavailable: true });
  });

  it('labels Ammora launches, never Verified or Graduated, and leaves flagged ones out', async () => {
    const out = await catalog.listAmmoraTokens(fakeSupabase(), fakeProvider(), {
      fetcher: okFetch([
        { address: TOKEN, status: 'ACTIVE' },
        { address: FAKE_FLZ, status: 'ACTIVE', blacklisted: true },
        { address: SLEEPY, status: 'MIGRATED' },
      ]),
    });
    assert.equal(out.unavailable, false);
    assert.deepEqual(out.tokens.map((t) => [t.symbol, t.status, t.tradable, t.source]), [
      ['AIV4C', 'active', true, 'Ammora launch'],
      ['SLEEPY', 'migrated', false, 'Ammora launch'],
    ]);
    assert.doesNotMatch(JSON.stringify(out), /verified|graduated/i);
  });

  it('sanitizes names and symbols on every view (Explore, swap picker, wallet)', async () => {
    const hostile = poolRow(TOKEN, '\u202eCSA\u0007<b>X</b>'.padEnd(40, 'Z'), { token_name: 'Free\u0000 money\nhttps://evil.example '.repeat(5) });
    const view = catalog.toView(webRoutes.fromRow(hostile), 'ACTIVE');
    for (const s of [view.symbol, view.name, view.label]) {
      assert.doesNotMatch(s, /[\u0000-\u001f\u007f\u202a-\u202e]/);
    }
    // displaySafeLabel cuts to max - 1 characters plus '...'.
    assert.ok(view.symbol.length <= 16 + 2);
    assert.ok(view.name.length <= 40 + 2);
    const holdings = await catalog.ammoraHoldingCandidates(fakeSupabase([hostile]));
    assert.doesNotMatch(holdings[0].symbol, /[\u0000-\u001f\u202a-\u202e]/);
    assert.ok(holdings[0].symbol.length <= 16 + 2);
    // Chat: the label goes through the same sanitizer.
    const chat = require('../lib/ammora/chat');
    assert.doesNotMatch(chat.labelFor(routesMod.fromRow(hostile)), /[\u0000-\u001f\u202a-\u202e]/);
  });

  it('Flizy symbols include FLIZY and NATIVE on both sides', () => {
    const chat = require('../lib/ammora/chat');
    for (const s of ['ETH', 'WETH', 'FLZ', 'FLIZY', 'NATIVE']) {
      assert.ok(catalog.flizySymbols().includes(s), `web ${s}`);
      assert.ok(chat.flizySymbols().includes(s), `bot ${s}`);
    }
    assert.deepEqual([...catalog.flizySymbols()].sort(), [...chat.flizySymbols()].sort());
  });

  function siteArgs(over = {}) {
    return { accountId: 'acc-1', chainId: venue.AMMORA_CHAIN_ID, gator: GATOR, side: 'buy', token: TOKEN, amount: '0.001', slippageBps: 100, confirmedMin: null, ...over };
  }

  it('quote: fee filled, rate shown, price impact unavailable', async () => {
    const fake = fakeSdk();
    webRoutes.setAmmoraSdkForTests(fake.sdk);
    const q = await site.ammoraSiteQuote(fakeSupabase(), fakeProvider(), { side: 'buy', token: TOKEN, amount: '0.001', slippageBps: 100 });
    assert.equal(q.fee.label, 'Ammora curve fee');
    assert.equal(q.fee.rate, '1.25%');
    assert.equal(q.priceImpact, 'unavailable');
    assert.equal(q.token.label, 'AIV4C (0xc232...3b6e, Ammora)');
  });

  it('quote: empty fee fields show no rate rather than a guess', async () => {
    const fake = fakeSdk({
      quote: (p) => ({ tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: 0n, expectedAmountOut: 1n, minimumAmountOut: 1n, priceImpactBps: 25n, fees: { total: null }, hops: [], router: ROUTER }),
    });
    webRoutes.setAmmoraSdkForTests(fake.sdk);
    const q = await site.ammoraSiteQuote(fakeSupabase(), fakeProvider(), { side: 'buy', token: TOKEN, amount: '0.001' });
    assert.equal(q.fee.amountEth, '0.0');
    assert.equal(q.fee.rate, '');
    assert.equal(q.priceImpact, '0.25%');
  });

  it('refuses a Flizy symbol, an unknown token and a token Ammora will not route', async () => {
    webRoutes.setAmmoraSdkForTests(fakeSdk().sdk);
    const sb = fakeSupabase();
    await assert.rejects(site.ammoraSiteQuote(sb, fakeProvider(), { side: 'buy', token: 'FLZ', amount: '1' }), { message: site.AMMORA_ROUTE_REFUSALS.flizy_symbol });
    await assert.rejects(site.ammoraSiteQuote(sb, fakeProvider(), { side: 'buy', token: STRANGER(), amount: '1' }), { message: site.AMMORA_ROUTE_REFUSALS.unknown });
    await assert.rejects(site.ammoraSiteQuote(sb, fakeProvider(), { side: 'buy', token: SLEEPY, amount: '1' }), { message: site.AMMORA_ROUTE_REFUSALS.not_tradable });
  });

  it('a route client the SDK cannot build is a 400 refusal, not a server error', async () => {
    const broken = fakeSdk();
    broken.sdk.AmmoraRouteClient.create = async () => {
      throw new Error('atomic multi-hop runtime verification failed');
    };
    webRoutes.setAmmoraSdkForTests(broken.sdk);
    await assert.rejects(site.ammoraSiteQuote(fakeSupabase(), fakeProvider(), { side: 'buy', token: TOKEN, amount: '1' }), {
      message: site.AMMORA_ROUTE_REFUSALS.unavailable,
    });
    // A Flizy symbol is refused from the inventory alone.
    await assert.rejects(site.ammoraSiteQuote(fakeSupabase(), fakeProvider(), { side: 'buy', token: 'FLZ', amount: '1' }), {
      message: site.AMMORA_ROUTE_REFUSALS.flizy_symbol,
    });
  });

  it('refuses a non-finalized curve at quote time', async () => {
    webRoutes.setAmmoraSdkForTests(fakeSdk({ quoteError: Object.assign(new Error('x'), { code: 'ARLORA_CONTRACT_UNSUPPORTED_TOKEN' }) }).sdk);
    await assert.rejects(site.ammoraSiteExecute(fakeSupabase(), fakeProvider(), siteArgs()), { message: site.AMMORA_ROUTE_REFUSALS.not_tradable });
  });

  it('refuses when the price moved past the reviewed minimum, before any row or send', async () => {
    webRoutes.setAmmoraSdkForTests(fakeSdk().sdk);
    const sb = fakeSupabase();
    await assert.rejects(site.ammoraSiteExecute(sb, fakeProvider(), siteArgs({ confirmedMin: '1000' })), { message: site.AMMORA_ROUTE_REFUSALS.price_moved });
    assert.equal(sb.writes.length, 0);
  });

  it('refuses a prepared swap to a router outside the pinned config', async () => {
    webRoutes.setAmmoraSdkForTests(
      fakeSdk({ prepare: (q) => ({ transaction: { to: STRANGER(), data: '0x', value: q.amountIn }, approvalRequirements: [], quote: q }) }).sdk
    );
    const sb = fakeSupabase();
    await assert.rejects(site.ammoraSiteExecute(sb, fakeProvider(), siteArgs()), { message: site.AMMORA_ROUTE_REFUSALS.policy });
    assert.equal(sb.writes.length, 0);
  });

  it('refuses a pinned-router call that pays a stranger, before any row or send', async () => {
    webRoutes.setAmmoraSdkForTests(
      fakeSdk({
        prepare: (q) => {
          return {
            transaction: {
              to: ROUTER,
              data: ROUTER_FN.encodeFunctionData('swapExactInput', [
                {
                  chainId: BigInt(venue.AMMORA_CHAIN_ID),
                  hops: [{ pool: poolRow(TOKEN, 'X').pool, tokenIn: venue.VENUE.contracts.wrappedNative.address, tokenOut: TOKEN, venueParams: '0x' }],
                  amountIn: q.amountIn,
                  minimumAmountOut: q.minimumAmountOut,
                  recipient: STRANGER(),
                  deadline: 2_000_000_000n,
                  referrer: ethers.ZeroAddress,
                  maximumIntegratorFeeBps: 0,
                  unwrapNative: false,
                },
              ]),
              value: q.amountIn,
            },
            approvalRequirements: [],
            quote: q,
          };
        },
      }).sdk
    );
    const sb = fakeSupabase();
    await assert.rejects(site.ammoraSiteExecute(sb, fakeProvider(), siteArgs()), { message: site.AMMORA_ROUTE_REFUSALS.policy });
    assert.equal(sb.writes.length, 0);
  });

  it('refuses when the pinned code no longer matches', async () => {
    webRoutes.setAmmoraSdkForTests(fakeSdk().sdk);
    webAttest.resetAttestation();
    await assert.rejects(site.ammoraSiteExecute(fakeSupabase(), fakeProvider({ code: '0x6002' }), siteArgs()), { message: site.AMMORA_ROUTE_REFUSALS.off });
  });

  it('flag off: refused before any read', async () => {
    disable();
    const provider = fakeProvider();
    const sb = fakeSupabase();
    await assert.rejects(site.ammoraSiteQuote(sb, provider, { side: 'buy', token: TOKEN, amount: '1' }), { message: site.AMMORA_ROUTE_REFUSALS.off });
    assert.equal(provider.calls.getCode + sb.reads, 0);
    assert.equal(webVenue.ammoraEnabled(), false);
  });
});

function STRANGER() {
  return '0x2222222222222222222222222222222222222222';
}
