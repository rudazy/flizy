/**
 * Limit orders: the price a person types becomes a minimum that is never above
 * what they asked for, and the watcher fills an order only when the pool
 * reaches it, with that minimum as the on-chain floor, once.
 *
 * The watcher runs against the fake database and a scripted pool, with the
 * swap itself stubbed: what is proven here is every decision the watcher makes
 * (expire, skip, claim, fill, fail, never twice). The on-chain floor is proven
 * by passing min_out through as amountOutMinWei, which the router enforces.
 *
 * Run: node --test test/limitOrders.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let W;
let L;
let chain;

before(async () => {
  W = await import('../web/lib/limitOrders.ts');
  L = require('../lib/limitOrders');
  chain = require('../lib/chains').getChain('giwa_sepolia');
  // No test here may reach a real database; see test/taskLifecycle.test.js.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const E18 = 10n ** 18n;

describe('minOutFromPrice', () => {
  it('turns "1 ETH for 500 FLZ" on 0.01 ETH into 5 FLZ', () => {
    assert.equal(W.minOutFromPrice(E18 / 100n, '500', 18, 18), 5n * E18);
  });

  it('handles a fractional price and different decimals', () => {
    // Sell 1000 FLZ (18 decimals) at 0.002 ETH each for a 6-decimal token: 2.0
    assert.equal(W.minOutFromPrice(1000n * E18, '0.002', 18, 6), 2_000_000n);
  });

  it('rounds down, so the minimum is never above the price asked', () => {
    // 1 wei in at 1.5 per unit cannot ask for 1.5 wei; it asks for 1.
    assert.equal(W.minOutFromPrice(1n, '1.5', 18, 18), 1n);
  });

  it('refuses a missing, zero, negative or malformed price', () => {
    for (const bad of ['', '0', '-1', 'abc', '1e5', '1.2.3']) {
      assert.throws(() => W.minOutFromPrice(E18, bad, 18, 18), /limit price|too small/, bad);
    }
  });

  it('refuses an order too small to receive anything', () => {
    assert.throws(() => W.minOutFromPrice(1n, '0.1', 18, 18), /too small/);
  });
});

describe('placing and cancelling', () => {
  it('stores wei as text and a deadline seven days out', async () => {
    const fake = createFakeSupabase({ limit_orders: [] });
    const now = Date.parse('2026-10-01T12:00:00Z');
    const placed = await W.placeLimitOrder('me', { side: 'buy', amountInWei: E18, minOutWei: 500n * E18 }, fake.client, now);
    const row = fake.db.tables.limit_orders[0];
    assert.equal(row.amount_in, '1000000000000000000');
    assert.equal(row.min_out, '500000000000000000000');
    assert.equal(row.status, 'open');
    assert.equal(Date.parse(placed.expiresAt) - now, W.LIMIT_ORDER_TTL_MS);
  });

  it('cancels only an open order of the same account', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const fake = createFakeSupabase({
      limit_orders: [{ id, account_id: 'me', status: 'open' }],
    });
    await assert.rejects(W.cancelLimitOrder('someone-else', id, fake.client), /no longer open/);
    assert.equal(fake.db.tables.limit_orders[0].status, 'open');
    await W.cancelLimitOrder('me', id, fake.client);
    assert.equal(fake.db.tables.limit_orders[0].status, 'cancelled');
    await assert.rejects(W.cancelLimitOrder('me', id, fake.client), /no longer open/);
    await assert.rejects(W.cancelLimitOrder('me', 'not-a-uuid', fake.client), /not found/);
  });
});

describe('the watcher', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z');
  const iso = (ms) => new Date(NOW + ms).toISOString();

  function book(rows) {
    return createFakeSupabase({
      limit_orders: rows.map((r) => ({
        account_id: 'me',
        side: 'buy',
        amount_in: String(E18 / 100n),
        min_out: String(5n * E18),
        status: 'open',
        created_at: iso(-60e3),
        updated_at: iso(-60e3),
        expires_at: iso(3600e3),
        ...r,
      })),
    });
  }

  function deps(fake, { out, execute } = {}) {
    const calls = { executed: [], locks: 0, releases: 0 };
    return {
      calls,
      args: {
        supabase: fake.client,
        provider: {},
        chain,
        now: NOW,
        quote: async () => ({ amountOut: out }),
        executePlan: async ({ plan }) => {
          calls.executed.push(plan);
          return execute ? execute(plan) : { ok: true, txHash: `0x${'ab'.repeat(32)}` };
        },
        lock: async () => {
          calls.locks += 1;
          return { ok: true };
        },
        release: async () => {
          calls.releases += 1;
        },
      },
    };
  }

  it('leaves an order open while the pool is below its price', async () => {
    const fake = book([{ id: 'o1' }]);
    const d = deps(fake, { out: 5n * E18 - 1n });
    const c = await L.runLimitOrderTick(d.args);
    assert.equal(c.filled, 0);
    assert.equal(d.calls.executed.length, 0);
    assert.equal(fake.db.tables.limit_orders[0].status, 'open');
  });

  it('fills at the price, with min_out as the on-chain minimum, and releases the lock', async () => {
    const fake = book([{ id: 'o1' }]);
    const d = deps(fake, { out: 5n * E18 });
    const c = await L.runLimitOrderTick(d.args);
    assert.equal(c.filled, 1);
    const plan = d.calls.executed[0];
    assert.equal(plan.input.amountOutMinWei, String(5n * E18));
    assert.equal(plan.input.amountInWei, String(E18 / 100n));
    assert.equal(plan.input.inIsNative, true);
    assert.equal(plan.actor.accountId, 'me');
    const row = fake.db.tables.limit_orders[0];
    assert.equal(row.status, 'filled');
    assert.match(row.tx_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(d.calls.releases, 1);
  });

  it('never fills the same order twice', async () => {
    const fake = book([{ id: 'o1' }]);
    const d = deps(fake, { out: 6n * E18 });
    await L.runLimitOrderTick(d.args);
    await L.runLimitOrderTick(d.args);
    assert.equal(d.calls.executed.length, 1);
  });

  it('sells FLZ for ETH the other way round', async () => {
    const fake = book([{ id: 'o1', side: 'sell', amount_in: String(1000n * E18), min_out: String(E18) }]);
    const d = deps(fake, { out: 2n * E18 });
    await L.runLimitOrderTick(d.args);
    const plan = d.calls.executed[0];
    assert.equal(plan.input.inIsNative, false);
    assert.equal(plan.input.outIsNative, true);
    assert.equal(plan.input.tokenOut, null);
    assert.match(plan.input.tokenIn, /^0x[0-9a-fA-F]{40}$/);
  });

  it('expires orders past their deadline and does not quote them', async () => {
    const fake = book([{ id: 'o1', expires_at: iso(-1) }]);
    const d = deps(fake, { out: 99n * E18 });
    const c = await L.runLimitOrderTick(d.args);
    assert.equal(c.expired, 1);
    assert.equal(d.calls.executed.length, 0);
    assert.equal(fake.db.tables.limit_orders[0].status, 'expired');
  });

  it('records a failed swap and does not reopen it', async () => {
    const fake = book([{ id: 'o1' }]);
    const d = deps(fake, { out: 6n * E18, execute: () => ({ ok: false, error: 'Not enough ETH.' }) });
    const c = await L.runLimitOrderTick(d.args);
    assert.equal(c.failed, 1);
    const row = fake.db.tables.limit_orders[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'Not enough ETH.');
    await L.runLimitOrderTick(d.args);
    assert.equal(d.calls.executed.length, 1);
  });

  it('puts an order back when the account is mid-payment, without swapping', async () => {
    const fake = book([{ id: 'o1' }]);
    const d = deps(fake, { out: 6n * E18 });
    d.args.lock = async () => ({ ok: false, error: 'busy' });
    await L.runLimitOrderTick(d.args);
    assert.equal(d.calls.executed.length, 0);
    assert.equal(fake.db.tables.limit_orders[0].status, 'open');
  });

  it('fails an order stuck in filling instead of reopening it', async () => {
    const fake = book([{ id: 'o1', status: 'filling', updated_at: iso(-L.FILLING_STALE_MS - 1) }]);
    const d = deps(fake, { out: 6n * E18 });
    const c = await L.runLimitOrderTick(d.args);
    assert.equal(c.interrupted, 1);
    assert.equal(fake.db.tables.limit_orders[0].status, 'failed');
    assert.equal(d.calls.executed.length, 0);
  });

  it('skips a cancelled order even if the pool reaches it', async () => {
    const fake = book([{ id: 'o1', status: 'cancelled' }]);
    const d = deps(fake, { out: 99n * E18 });
    await L.runLimitOrderTick(d.args);
    assert.equal(d.calls.executed.length, 0);
  });
});

describe('the route and the bot wiring', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'swap', 'limit', 'route.ts'), 'utf8');

  it('takes the password to place, and the account from the session', () => {
    assert.match(route, /requirePassword\(supabase, accountId, String\(body\.password \|\| ''\), 'place a limit order'\)/);
    assert.match(route, /const accountId = await getAccountIdFromCookie\(\);/);
    assert.match(route, /rejectIfCrossOrigin\(req\)/);
  });

  it('starts the watcher once, in the WhatsApp process, after the schema check', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(index, /await assertSchema\(\);[\s\S]{0,400}startLimitOrderWatcher\(\{ supabase, provider, chain \}\);/);
    const telegram = fs.readFileSync(path.join(__dirname, '..', 'telegram.js'), 'utf8');
    assert.doesNotMatch(telegram, /startLimitOrderWatcher/);
  });
});
