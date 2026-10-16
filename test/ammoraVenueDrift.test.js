/**
 * The Ammora venue rules, on both sides (lib/ammora/venue.js and
 * web/lib/ammora/venue.ts), with the same inputs: the pinned config, token
 * identity (Flizy symbols first, collisions by address only), the fee and
 * price-impact view, the policy check on a prepared swap, and exact
 * approvals.
 *
 * Run: node --test test/ammoraVenueDrift.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../lib/ammora/venue');
let web;
before(async () => {
  web = await import('../web/lib/ammora/venue.ts');
});
const sides = () => [['bot', bot], ['web', web]];

const ROUTER = bot.VENUE.contracts.aggregationRouter.address;
const NATIVE_ROUTER = bot.VENUE.contracts.nativeRouter.address;
const WETH = bot.VENUE.contracts.wrappedNative.address;
const TOKEN = '0xc23220d34534aE3C8bbe231dB911b7E662743B6e';
const FAKE_FLZ = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';

const inventory = [
  { baseToken: TOKEN.toLowerCase(), symbol: 'AIV4C', tradable: true },
  { baseToken: FAKE_FLZ, symbol: 'FLZ', tradable: true },
  { baseToken: '0x3333333333333333333333333333333333333333', symbol: 'TWIN', tradable: true },
  { baseToken: '0x4444444444444444444444444444444444444444', symbol: 'twin', tradable: true },
  { baseToken: '0x5555555555555555555555555555555555555555', symbol: 'SLEEPY', tradable: false },
];
const FLIZY = ['ETH', 'WETH', 'FLZ', 'IZY', 'MAKI'];

describe('the pinned venue config', () => {
  it('is the same file on both sides', () => {
    const root = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'ammora-giwa-sepolia.json'), 'utf8'));
    const webCopy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'generated', 'ammoraVenue.json'), 'utf8'));
    assert.deepEqual(webCopy, root);
  });

  it('says it is self-attested, and pins a code hash for every contract', () => {
    assert.equal(bot.VENUE.attestation, 'self-attested');
    assert.match(bot.VENUE.note, /Not signed by Ammora/);
    for (const [role, c] of Object.entries(bot.VENUE.contracts)) {
      assert.match(c.address, /^0x[0-9a-fA-F]{40}$/, role);
      assert.match(c.codeHash, /^0x[0-9a-f]{64}$/, role);
    }
    assert.deepEqual(bot.VENUE.swapTargets, ['aggregationRouter']);
  });

  it('only the aggregation router is a swap target; the native router is pinned but never sent to', () => {
    for (const [, m] of sides()) {
      assert.equal(m.isSwapTarget(ROUTER), true);
      assert.equal(m.isSwapTarget(NATIVE_ROUTER.toLowerCase()), false);
      assert.equal(m.isSwapTarget(WETH), false);
      assert.equal(m.isSwapTarget(STRANGER), false);
    }
  });
});

describe('flag', () => {
  it('is off unless AMMORA_ENABLED is exactly true', () => {
    for (const [, m] of sides()) {
      assert.equal(m.ammoraEnabled({}), false);
      assert.equal(m.ammoraEnabled({ AMMORA_ENABLED: '1' }), false);
      assert.equal(m.ammoraEnabled({ AMMORA_ENABLED: 'false' }), false);
      assert.equal(m.ammoraEnabled({ AMMORA_ENABLED: 'true' }), true);
      assert.equal(m.ammoraEnabled({ AMMORA_ENABLED: ' TRUE ' }), true);
    }
  });
});

describe('token identity: symbols are attacker-controlled', () => {
  it('an Ammora token named FLZ cannot be reached by symbol, only by address', () => {
    for (const [, m] of sides()) {
      assert.deepEqual(m.resolveAmmoraToken('FLZ', inventory, FLIZY), { ok: false, reason: 'flizy_symbol' });
      assert.deepEqual(m.resolveAmmoraToken('flz', inventory, FLIZY), { ok: false, reason: 'flizy_symbol' });
      const byAddress = m.resolveAmmoraToken(FAKE_FLZ, inventory, FLIZY);
      assert.equal(byAddress.ok, true);
      assert.equal(byAddress.token.baseToken, FAKE_FLZ);
    }
  });

  it('a unique non-Flizy symbol resolves, case-insensitively', () => {
    for (const [, m] of sides()) {
      const r = m.resolveAmmoraToken('aiv4c', inventory, FLIZY);
      assert.equal(r.ok, true);
      assert.equal(r.token.baseToken, TOKEN.toLowerCase());
    }
  });

  it('a symbol two Ammora tokens share resolves to neither', () => {
    for (const [, m] of sides()) assert.deepEqual(m.resolveAmmoraToken('TWIN', inventory, FLIZY), { ok: false, reason: 'ambiguous' });
  });

  it('a token that is not tradable is refused by symbol and by address', () => {
    for (const [, m] of sides()) {
      assert.deepEqual(m.resolveAmmoraToken('SLEEPY', inventory, FLIZY), { ok: false, reason: 'not_tradable' });
      assert.deepEqual(m.resolveAmmoraToken('0x5555555555555555555555555555555555555555', inventory, FLIZY), { ok: false, reason: 'not_tradable' });
    }
  });

  it('unknown symbols and addresses are unknown', () => {
    for (const [, m] of sides()) {
      assert.deepEqual(m.resolveAmmoraToken('NOPE', inventory, FLIZY), { ok: false, reason: 'unknown' });
      assert.deepEqual(m.resolveAmmoraToken(STRANGER, inventory, FLIZY), { ok: false, reason: 'unknown' });
      assert.deepEqual(m.resolveAmmoraToken('', inventory, FLIZY), { ok: false, reason: 'unknown' });
    }
  });

  it('every label shows the sanitized symbol, the short address and the source', () => {
    const sanitize = (s) => s.replace(/[\r\n\u202e]/g, '').slice(0, 12);
    for (const [, m] of sides()) {
      assert.equal(m.ammoraTokenLabel('AIV4C', TOKEN, sanitize), 'AIV4C (0xc232...3B6e, Ammora)');
      assert.equal(m.ammoraTokenLabel('F\nLZ\u202e', FAKE_FLZ, sanitize), 'FLZ (0x1111...1111, Ammora)');
      assert.equal(m.ammoraTokenLabel('', TOKEN, sanitize), 'token (0xc232...3B6e, Ammora)');
    }
  });
});

describe('fee and price impact', () => {
  const E = 10n ** 18n;
  it('an empty breakdown is the Ammora curve fee, with its rate (buy, fee from input)', () => {
    for (const [, m] of sides()) {
      const v = m.ammoraFeeView(
        { amountIn: 2n * E / 1000n, expectedAmountOut: 1n, priceImpactBps: null, fees: { total: 25n * 10n ** 12n, token: WETH, lp: null, protocol: null, creator: null } },
        { nativeIn: true }
      );
      assert.equal(v.label, 'Ammora curve fee');
      assert.equal(v.rateBps, 125);
      assert.equal(m.bpsText(v.rateBps), '1.25%');
      assert.equal(v.priceImpact, 'unavailable');
    }
  });

  it('a sell takes the fee from the output', () => {
    for (const [, m] of sides()) {
      const v = m.ammoraFeeView(
        { amountIn: 1n, expectedAmountOut: 1_950_312_499_915_613n, priceImpactBps: null, fees: { total: 24_687_499_998_932n, token: WETH } },
        { nativeIn: false }
      );
      assert.equal(v.rateBps, 125);
    }
  });

  it('a filled breakdown is labelled as the Ammora fee; a real price impact is shown', () => {
    for (const [, m] of sides()) {
      const v = m.ammoraFeeView(
        { amountIn: 10_000n, expectedAmountOut: 1n, priceImpactBps: 37n, fees: { total: 100n, token: WETH, lp: 60n, protocol: 40n, creator: null } },
        { nativeIn: true }
      );
      assert.equal(v.label, 'Ammora fee');
      assert.equal(v.rateBps, 100);
      assert.equal(v.priceImpact, '0.37%');
    }
  });
});

describe('policy on a prepared swap', () => {
  // The router call, built here from its own fragment so the test does not
  // lean on the decoder it is checking.
  const ROUTER_FN = new ethers.Interface([
    'function swapExactInput((uint256 chainId, (address pool, address tokenIn, address tokenOut, bytes venueParams)[] hops, uint256 amountIn, uint256 minimumAmountOut, address recipient, uint256 deadline, address referrer, uint16 maximumIntegratorFeeBps, bool unwrapNative) p) payable',
  ]);
  const GATOR = '0x9999999999999999999999999999999999999999';
  const POOL = '0x2c4e147617ca14502c438a35a370680494e8bd7b';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const call = (over = {}) =>
    ROUTER_FN.encodeFunctionData('swapExactInput', [
      {
        chainId: 91342n,
        hops: [{ pool: POOL, tokenIn: WETH, tokenOut: TOKEN, venueParams: '0x' }],
        amountIn: 1000n,
        minimumAmountOut: 90n,
        recipient: GATOR,
        deadline: 2_000_000_000n,
        referrer: ZERO,
        maximumIntegratorFeeBps: 0,
        unwrapNative: false,
        ...over,
      },
    ]);
  const sellCall = (over = {}) =>
    call({ hops: [{ pool: POOL, tokenIn: TOKEN, tokenOut: WETH, venueParams: '0x' }], amountIn: 500n, minimumAmountOut: 40n, unwrapNative: true, ...over });
  const buy = (data = call()) => ({
    transaction: { to: ROUTER, data, value: 1000n },
    approvalRequirements: [],
    quote: { tokenIn: bot.NATIVE, tokenOut: TOKEN, amountIn: 1000n, router: ROUTER },
  });
  const sell = (data = sellCall()) => ({
    transaction: { to: ROUTER, data, value: 0n },
    approvalRequirements: [{ token: TOKEN, spender: ROUTER, amount: 500n }],
    quote: { tokenIn: TOKEN, tokenOut: bot.NATIVE, amountIn: 500n, router: ROUTER },
  });
  const expectBuy = { attested: true, tokenIn: null, tokenOut: TOKEN, amountIn: 1000n, minimumAmountOut: 90n, recipient: GATOR, pools: [POOL] };
  const expectSell = { attested: true, tokenIn: TOKEN, tokenOut: null, amountIn: 500n, minimumAmountOut: 40n, recipient: GATOR, pools: [POOL] };

  it('passes a buy and a sell that match', () => {
    for (const [, m] of sides()) {
      assert.deepEqual(m.checkPrepared(buy(), expectBuy), { ok: true });
      assert.deepEqual(m.checkPrepared(sell(), expectSell), { ok: true });
    }
  });

  it('refuses everything when the pinned code check has not passed', () => {
    for (const [, m] of sides()) assert.deepEqual(m.checkPrepared(buy(), { ...expectBuy, attested: false }), { ok: false, reason: 'venue_off' });
  });

  it('refuses a target or a quote router not in the pinned config, the native router included', () => {
    for (const [, m] of sides()) {
      assert.equal(m.checkPrepared({ ...buy(), transaction: { to: STRANGER, data: call(), value: 1000n } }, expectBuy).reason, 'router_not_pinned');
      assert.equal(m.checkPrepared({ ...buy(), transaction: { to: NATIVE_ROUTER, data: call(), value: 1000n } }, expectBuy).reason, 'router_not_pinned');
      assert.equal(m.checkPrepared({ ...buy(), quote: { ...buy().quote, router: STRANGER } }, expectBuy).reason, 'router_not_pinned');
    }
  });

  it('refuses a quote for another token, amount, or ETH value, and any ETH on a sell', () => {
    for (const [, m] of sides()) {
      assert.equal(m.checkPrepared({ ...buy(), quote: { ...buy().quote, tokenOut: STRANGER } }, expectBuy).reason, 'quote_mismatch');
      assert.equal(m.checkPrepared({ ...buy(), quote: { ...buy().quote, amountIn: 999n } }, expectBuy).reason, 'quote_mismatch');
      assert.equal(m.checkPrepared({ ...buy(), transaction: { to: ROUTER, data: call(), value: 2000n } }, expectBuy).reason, 'quote_mismatch');
      assert.equal(m.checkPrepared({ ...sell(), transaction: { to: ROUTER, data: sellCall(), value: 1n } }, expectSell).reason, 'quote_mismatch');
    }
  });

  it('refuses calldata that pays anyone but the account', () => {
    for (const [, m] of sides()) {
      assert.equal(m.checkPrepared(buy(call({ recipient: STRANGER })), expectBuy).reason, 'recipient');
      assert.equal(m.checkPrepared(sell(sellCall({ recipient: STRANGER })), expectSell).reason, 'recipient');
      assert.equal(m.checkPrepared(buy(call({ referrer: STRANGER })), expectBuy).reason, 'integrator_fee');
      assert.equal(m.checkPrepared(buy(call({ maximumIntegratorFeeBps: 30 })), expectBuy).reason, 'integrator_fee');
    }
  });

  it('refuses a hop through a pool Flizy did not discover, or a broken route', () => {
    for (const [, m] of sides()) {
      const hop = (h) => buy(call({ hops: [h] }));
      assert.equal(m.checkPrepared(hop({ pool: STRANGER, tokenIn: WETH, tokenOut: TOKEN, venueParams: '0x' }), expectBuy).reason, 'pool_not_known');
      assert.equal(m.checkPrepared(hop({ pool: POOL, tokenIn: WETH, tokenOut: STRANGER, venueParams: '0x' }), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(hop({ pool: POOL, tokenIn: STRANGER, tokenOut: TOKEN, venueParams: '0x' }), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(buy(call({ hops: [] })), expectBuy).reason, 'calldata');
    }
  });

  it('refuses calldata that differs from the quote, or is not the swap call at all', () => {
    const approve = new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [STRANGER, 1n]);
    for (const [, m] of sides()) {
      assert.equal(m.checkPrepared(buy(call({ amountIn: 999n })), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(buy(call({ minimumAmountOut: 1n })), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(buy(call({ minimumAmountOut: 0n })), { ...expectBuy, minimumAmountOut: 0n }).reason, 'calldata');
      assert.equal(m.checkPrepared(buy(call({ chainId: 1n })), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(buy(call({ unwrapNative: true })), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(buy('0xabcdef'), expectBuy).reason, 'calldata');
      assert.equal(m.checkPrepared(buy(approve), expectBuy).reason, 'calldata');
    }
  });

  it('refuses an approval to another spender, of another token, or above the amount', () => {
    for (const [, m] of sides()) {
      const s = sell();
      assert.equal(m.checkPrepared({ ...s, approvalRequirements: [{ token: TOKEN, spender: STRANGER, amount: 500n }] }, expectSell).reason, 'approval_spender');
      assert.equal(m.checkPrepared({ ...s, approvalRequirements: [{ token: TOKEN, spender: NATIVE_ROUTER, amount: 500n }] }, expectSell).reason, 'approval_spender');
      assert.equal(m.checkPrepared({ ...s, approvalRequirements: [{ token: STRANGER, spender: ROUTER, amount: 500n }] }, expectSell).reason, 'approval_token');
      assert.equal(m.checkPrepared({ ...s, approvalRequirements: [{ token: TOKEN, spender: ROUTER, amount: 2n ** 256n - 1n }] }, expectSell).reason, 'approval_amount');
      assert.equal(m.checkPrepared({ ...buy(), approvalRequirements: [{ token: TOKEN, spender: ROUTER, amount: 1n }] }, expectBuy).reason, 'approval_token');
    }
  });
});

describe('approvals: zero then exact, never unlimited', () => {
  it('no allowance: the exact amount only', () => {
    for (const [, m] of sides()) assert.deepEqual(m.approvalSteps({ amount: 500n }, 0n), [500n]);
  });
  it('an allowance already there: zero first, then exact', () => {
    for (const [, m] of sides()) assert.deepEqual(m.approvalSteps({ amount: 500n }, 7n), [0n, 500n]);
  });
  it('a token that asks for a reset: zero first even from nothing', () => {
    for (const [, m] of sides()) assert.deepEqual(m.approvalSteps({ amount: 500n, resetToZero: true }, 0n), [0n, 500n]);
  });
  it('exactly the right allowance already: nothing to send', () => {
    for (const [, m] of sides()) assert.deepEqual(m.approvalSteps({ amount: 500n }, 500n), []);
  });
  it('never approves more than the requirement', () => {
    for (const [, m] of sides()) {
      for (const cur of [0n, 1n, 499n, 501n, 10n ** 30n]) {
        for (const step of m.approvalSteps({ amount: 500n }, cur)) assert.ok(step <= 500n);
      }
    }
  });
});
