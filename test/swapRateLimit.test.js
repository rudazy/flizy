/**
 * Hourly swap cap — the thing that replaced the password prompt on
 * POST /api/swap/execute.
 *
 * The cap is the ONLY brake left on that route, so these tests care as much
 * about what it refuses to count (other accounts, other kinds, rows aged out of
 * the window) as about the refusal itself. An over-broad count would lock a
 * user out of their own swaps because they sent money an hour ago.
 *
 * Run: node --test test/swapRateLimit.test.js
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ACCOUNT = 'acc-swapper';
const OTHER = 'acc-bystander';

let limiter;
let savedMax;

before(async () => {
  limiter = await import('../web/lib/swapRateLimit.ts');
  savedMax = process.env.SWAP_MAX_PER_HOUR;
});

beforeEach(() => {
  delete process.env.SWAP_MAX_PER_HOUR;
});

after(() => {
  if (savedMax === undefined) delete process.env.SWAP_MAX_PER_HOUR;
  else process.env.SWAP_MAX_PER_HOUR = savedMax;
});

const NOW = Date.UTC(2026, 7, 30, 22, 0, 0);

/** @param {number} minutesAgo @param {object} [extra] */
function swapRow(minutesAgo, extra = {}) {
  return {
    account_id: ACCOUNT,
    kind: 'swap',
    status: 'confirmed',
    created_at: new Date(NOW - minutesAgo * 60 * 1000).toISOString(),
    ...extra,
  };
}

function withTransfers(rows) {
  return createFakeSupabase({ transfers: rows }).client;
}

describe('swapsPerWindow', () => {
  it('defaults to 12', () => {
    assert.equal(limiter.swapsPerWindow(), 12);
  });

  it('honours SWAP_MAX_PER_HOUR', () => {
    process.env.SWAP_MAX_PER_HOUR = '3';
    assert.equal(limiter.swapsPerWindow(), 3);
  });

  it('falls back to the default on a junk value rather than disabling the cap', () => {
    for (const bad of ['nonsense', '0', '-5', '']) {
      process.env.SWAP_MAX_PER_HOUR = bad;
      assert.equal(limiter.swapsPerWindow(), 12, `bad value ${JSON.stringify(bad)} disabled the cap`);
    }
  });
});

describe('checkSwapRateLimit', () => {
  it('allows a swap when the account is under the cap', async () => {
    process.env.SWAP_MAX_PER_HOUR = '3';
    const supabase = withTransfers([swapRow(10), swapRow(20)]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.used, 2);
    assert.equal(result.max, 3);
  });

  it('refuses with 429 once the cap is reached', async () => {
    process.env.SWAP_MAX_PER_HOUR = '3';
    const supabase = withTransfers([swapRow(10), swapRow(20), swapRow(30)]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.code, 'SWAP_RATE_LIMITED');
    assert.match(result.error, /3 swaps in an hour/);
  });

  it('counts failed swaps too, so a caller whose swaps revert cannot spin', async () => {
    process.env.SWAP_MAX_PER_HOUR = '2';
    const supabase = withTransfers([
      swapRow(5, { status: 'failed' }),
      swapRow(6, { status: 'pending' }),
    ]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, false);
  });

  it('ignores rows that have aged out of the window', async () => {
    process.env.SWAP_MAX_PER_HOUR = '2';
    const supabase = withTransfers([swapRow(61), swapRow(120), swapRow(10)]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, true, 'hour-old swaps should not count against the cap');
    assert.equal(result.used, 1);
  });

  it('ignores other accounts', async () => {
    process.env.SWAP_MAX_PER_HOUR = '2';
    const supabase = withTransfers([
      swapRow(5, { account_id: OTHER }),
      swapRow(6, { account_id: OTHER }),
      swapRow(7),
    ]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.used, 1);
  });

  it('ignores non-swap money rows, so sending does not eat the swap allowance', async () => {
    process.env.SWAP_MAX_PER_HOUR = '2';
    const supabase = withTransfers([
      swapRow(5, { kind: 'send' }),
      swapRow(6, { kind: 'claim' }),
      swapRow(7),
    ]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.used, 1);
  });

  it('reports the wait from the oldest swap in the window, not from now', async () => {
    process.env.SWAP_MAX_PER_HOUR = '2';
    // Oldest is 50 minutes old, so it leaves the window in 10 minutes.
    const supabase = withTransfers([swapRow(50), swapRow(5)]);
    const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
    assert.equal(result.ok, false);
    assert.match(result.error, /10 minutes/);
  });

  it('degrades open with a warning when the counter cannot be read', async () => {
    const supabase = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          gte() {
            return this;
          },
          then(resolve) {
            resolve({ data: null, error: { message: 'relation does not exist' } });
          },
        };
      },
    };
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const result = await limiter.checkSwapRateLimit(supabase, ACCOUNT, NOW);
      assert.equal(result.ok, true);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cap NOT enforced/);
  });

  it('does not blow up without an account id', async () => {
    const supabase = withTransfers([]);
    const result = await limiter.checkSwapRateLimit(supabase, '', NOW);
    assert.equal(result.ok, true);
  });
});
