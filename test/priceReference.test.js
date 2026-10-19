/**
 * The reference price that lets a swap or a liquidity change on a verified
 * pool skip the PIN (lib/priceReference.js).
 *
 * The attack it exists for: someone with a stolen session moves the pool with
 * a trade of their own, fires the owner's swap into the moved price, then
 * trades back. The cases below are that attack and its edges.
 *
 * Run: node --test test/priceReference.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const P = require('../lib/priceReference');

const E18 = 10n ** 18n;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-19T12:07:00.000Z');
const TOKEN = '0x' + 'a'.repeat(40);
const PAIR = '0x' + 'b'.repeat(40);
const WETH = '0x' + 'c'.repeat(40);

/** A pool at 1 ETH : 1000 tokens, so one token is 0.001 ETH. */
const RES = { eth: 100n * E18, token: 100_000n * E18 };
const REF = P.priceFromReserves(RES.eth, RES.token);

/** Snapshot rows, newest first, `ages` in minutes before NOW's bucket. */
function rows(ages, reserves = RES) {
  const bucketNow = Date.parse(P.bucketStart(NOW));
  return ages.map((m) => ({
    bucket: new Date(bucketNow - m * MIN).toISOString(),
    reserve_eth: String(reserves.eth),
    reserve_token: String(reserves.token),
  }));
}

describe('referencePrice', () => {
  it('is the median of the newest four snapshots', () => {
    const r = [
      ...rows([0], { eth: 100n * E18, token: 100_000n * E18 }),
      ...rows([15], { eth: 102n * E18, token: 100_000n * E18 }),
      ...rows([30], { eth: 98n * E18, token: 100_000n * E18 }),
      // One far outlier, as a single manipulated snapshot would be.
      ...rows([45], { eth: 1000n * E18, token: 100_000n * E18 }),
    ];
    const median = (P.priceFromReserves(100n * E18, 100_000n * E18) + P.priceFromReserves(102n * E18, 100_000n * E18)) / 2n;
    assert.equal(P.referencePrice(r, NOW), median);
  });

  it('one manipulated snapshot moves the median by at most the gap between honest ones', () => {
    const honest = rows([0, 15, 30]);
    const poisoned = rows([45], { eth: 10_000n * E18, token: 100_000n * E18 });
    assert.equal(P.referencePrice([...honest, ...poisoned], NOW), REF);
  });

  it('uses only the newest four', () => {
    const r = [...rows([0, 15, 30, 45]), ...rows([60, 75], { eth: 500n * E18, token: 100_000n * E18 })];
    assert.equal(P.referencePrice(r, NOW), REF);
  });

  it('is null with fewer than four snapshots', () => {
    assert.equal(P.referencePrice(rows([0, 15, 30]), NOW), null);
    assert.equal(P.referencePrice([], NOW), null);
    assert.equal(P.referencePrice(null, NOW), null);
  });

  it('is null when the newest is over 30 minutes old', () => {
    // NOW is 7 minutes into its bucket, so a snapshot 30 minutes before the bucket is 37 old.
    assert.equal(P.referencePrice(rows([30, 45, 60, 75]), NOW), null);
    assert.notEqual(P.referencePrice(rows([15, 30, 45, 60]), NOW), null);
  });

  it('is null when the oldest of the four is over 90 minutes old', () => {
    // One missing bucket is fine (oldest 67 minutes); a long gap is not.
    assert.notEqual(P.referencePrice(rows([0, 15, 30, 60]), NOW), null);
    assert.equal(P.referencePrice(rows([0, 15, 30, 90]), NOW), null);
  });

  it('ignores rows from the future, empty pools and junk', () => {
    const good = rows([0, 15, 30, 45]);
    const future = { bucket: new Date(NOW + 60 * MIN).toISOString(), reserve_eth: '1', reserve_token: '1' };
    const empty = { bucket: good[0].bucket, reserve_eth: '0', reserve_token: '5' };
    const junk = { bucket: 'nope', reserve_eth: 'x', reserve_token: 'y' };
    assert.equal(P.referencePrice([future, empty, junk, ...good], NOW), REF);
    assert.equal(P.referencePrice([future, ...good.slice(0, 3)], NOW), null);
  });
});

describe('checkPoolPrice', () => {
  it('passes within 5% either side, inclusive', () => {
    for (const bps of [0n, 100n, 499n, 500n]) {
      const up = REF + (REF * bps) / 10000n;
      const down = REF - (REF * bps) / 10000n;
      assert.equal(P.checkPoolPrice({ reference: REF, spot: up }).ok, true, `+${bps}`);
      assert.equal(P.checkPoolPrice({ reference: REF, spot: down }).ok, true, `-${bps}`);
    }
  });

  it('fails past 5%, and with no reference or no spot', () => {
    assert.deepEqual(P.checkPoolPrice({ reference: REF, spot: REF + (REF * 501n) / 10000n }), { ok: false, reason: 'price_moved' });
    assert.deepEqual(P.checkPoolPrice({ reference: REF, spot: REF - (REF * 501n) / 10000n }), { ok: false, reason: 'price_moved' });
    assert.deepEqual(P.checkPoolPrice({ reference: null, spot: REF }), { ok: false, reason: 'no_reference' });
    assert.deepEqual(P.checkPoolPrice({ reference: REF, spot: null }), { ok: false, reason: 'no_spot' });
  });
});

describe('checkSwapPrice', () => {
  const ONE = E18;

  it('a fair buy passes: 1 ETH for at least 990 tokens', () => {
    assert.equal(P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: true, amountIn: ONE, amountOutMin: 990n * E18 }).ok, true);
  });

  it('a fair sell passes: 1000 tokens for at least 0.99 ETH', () => {
    assert.equal(
      P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: false, amountIn: 1000n * E18, amountOutMin: (99n * E18) / 100n }).ok,
      true
    );
  });

  it('the worst fill may be at most 5% under the reference value', () => {
    const buy = (min) => P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: true, amountIn: ONE, amountOutMin: min });
    assert.equal(buy(950n * E18).ok, true);
    assert.deepEqual(buy(950n * E18 - 1n), { ok: false, reason: 'worst_fill' });
    const sell = (min) => P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: false, amountIn: 1000n * E18, amountOutMin: min });
    assert.equal(sell((95n * E18) / 100n).ok, true);
    assert.deepEqual(sell((95n * E18) / 100n - 1n), { ok: false, reason: 'worst_fill' });
  });

  it('the attack: a pool pumped 10x before the swap needs the PIN', () => {
    // The attacker bought the token up, so a token now costs 0.01 ETH, and the
    // fresh quote (with its 1% slippage) reflects that.
    const pumped = REF * 10n;
    const amountOutMin = (99n * E18 * 99n) / 100n; // about 98 tokens for 1 ETH
    assert.deepEqual(
      P.checkSwapPrice({ reference: REF, spot: pumped, inIsNative: true, amountIn: ONE, amountOutMin }),
      { ok: false, reason: 'price_moved' }
    );
  });

  it('a trade too big for the pool needs the PIN, even at a fair spot', () => {
    // Its own price impact makes the worst fill far under the reference.
    assert.deepEqual(
      P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: true, amountIn: 50n * ONE, amountOutMin: 30_000n * E18 }),
      { ok: false, reason: 'worst_fill' }
    );
  });

  it('a missing or zero amount needs the PIN', () => {
    for (const [amountIn, amountOutMin] of [
      [0n, 1n],
      [1n, 0n],
      [undefined, 1n],
      [1n, undefined],
    ]) {
      assert.equal(P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: true, amountIn, amountOutMin }).ok, false);
    }
  });

  it('a sell too small to have a value at the reference needs the PIN', () => {
    // A million units is 1000 wei at the reference: valued, and fair.
    assert.deepEqual(
      P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: false, amountIn: 10n ** 6n, amountOutMin: 1000n }),
      { ok: true, reason: 'in_band' }
    );
    // One unit rounds to 0 wei, so it has no value to hold the fill to.
    assert.deepEqual(
      P.checkSwapPrice({ reference: REF, spot: REF, inIsNative: false, amountIn: 1n, amountOutMin: 1n }),
      { ok: false, reason: 'bad_amount' }
    );
  });
});

describe('priceFromReserves and buckets', () => {
  it('keeps 6-decimal tokens precise', () => {
    // 1 ETH : 3000 whole tokens of 6 decimals. Valued back, the pool's token
    // side comes to 1 ETH less at most one wei of rounding.
    const p = P.priceFromReserves(E18, 3000n * 10n ** 6n);
    assert.ok(p > 0n);
    const back = (3000n * 10n ** 6n * p) / P.PRICE_SCALE;
    assert.ok(E18 - back <= 1n && back <= E18, String(back));
  });

  it('rejects empty and junk reserves', () => {
    assert.equal(P.priceFromReserves(0n, 1n), null);
    assert.equal(P.priceFromReserves(1n, 0n), null);
    assert.equal(P.priceFromReserves('x', 1n), null);
  });

  it('cuts time into 15 minute buckets', () => {
    assert.equal(P.bucketStart(Date.parse('2026-10-19T12:07:59.999Z')), '2026-10-19T12:00:00.000Z');
    assert.equal(P.bucketStart(Date.parse('2026-10-19T12:15:00.000Z')), '2026-10-19T12:15:00.000Z');
  });

  it('lists FLZ and every listed token, lower case, and finds a pool by token', () => {
    const pools = P.verifiedPools({ flz: TOKEN.toUpperCase().replace('0X', '0x'), pair: PAIR }, [{ address: WETH, pair: PAIR }]);
    assert.deepEqual(pools, [
      { token: TOKEN, pair: PAIR },
      { token: WETH, pair: PAIR },
    ]);
    assert.deepEqual(P.poolForToken(pools, TOKEN.toUpperCase().replace('0X', '0x')), { token: TOKEN, pair: PAIR });
    assert.equal(P.poolForToken(pools, null), null);
    assert.equal(P.poolForToken(pools, '0x' + 'd'.repeat(40)), null);
  });
});

/** A provider that answers getReserves and token0 for one pair. */
function pairProvider({ reserveToken, reserveEth, tokenIs0 = true, fail = false }) {
  const iface = new ethers.Interface([
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
  ]);
  return {
    call: async (tx) => {
      if (fail) throw new Error('rpc down');
      const fn = iface.getFunction(tx.data.slice(0, 10));
      if (fn.name === 'token0') return iface.encodeFunctionResult('token0', [tokenIs0 ? TOKEN : WETH]);
      const [r0, r1] = tokenIs0 ? [reserveToken, reserveEth] : [reserveEth, reserveToken];
      return iface.encodeFunctionResult('getReserves', [r0, r1, 0]);
    },
  };
}

/**
 * Just the read lib/priceReference.js makes, ordered newest first. Like
 * PostgREST, a numeric column comes back as a JSON number unless the select
 * casts it with ::text, and a number that large has lost its digits.
 */
function snapshotDb(list, { error = null } = {}) {
  return {
    from: (table) => {
      assert.equal(table, 'token_price_snapshots');
      const filters = [];
      let columns = '';
      const shape = (r) => {
        const out = { ...r };
        for (const col of ['reserve_eth', 'reserve_token']) {
          if (!columns.includes(`${col}::text`)) out[col] = Number(r[col]);
        }
        return out;
      };
      const q = {
        select: (cols) => ((columns = String(cols)), q),
        eq: (col, v) => (filters.push((r) => String(r[col]) === String(v)), q),
        lte: (col, v) => (filters.push((r) => String(r[col]) <= String(v)), q),
        order: () => q,
        limit: async (n) =>
          error
            ? { data: null, error }
            : {
                data: list
                  .filter((r) => filters.every((f) => f(r)))
                  .sort((a, b) => (a.bucket < b.bucket ? 1 : -1))
                  .slice(0, n)
                  .map(shape),
                error: null,
              },
      };
      return q;
    },
  };
}

describe('swapPriceCheck and poolPriceCheck, read fresh', () => {
  const pool = { token: TOKEN, pair: PAIR };
  const stored = rows([0, 15, 30, 45]).map((r) => ({ ...r, chain_id: 91342, token: TOKEN }));

  it('pass on a fair pool and a fair fill, whichever side token0 is', async () => {
    for (const tokenIs0 of [true, false]) {
      const provider = pairProvider({ reserveToken: RES.token, reserveEth: RES.eth, tokenIs0 });
      const out = await P.swapPriceCheck({
        supabase: snapshotDb(stored),
        provider,
        chainId: 91342,
        pool,
        inIsNative: true,
        // 0.01 ETH is 10 tokens at the reference; a 9.6 token floor is 4% under.
        amountIn: E18 / 100n,
        amountOutMin: (96n * E18) / 10n,
        nowMs: NOW,
      });
      assert.deepEqual(out, { ok: true, reason: 'in_band' }, `tokenIs0=${tokenIs0}`);
      assert.deepEqual(await P.poolPriceCheck({ supabase: snapshotDb(stored), provider, chainId: 91342, pool, nowMs: NOW }), {
        ok: true,
        reason: 'in_band',
      });
    }
  });

  it('a reserve read as a JSON number is never trusted as a price', () => {
    // What an uncast numeric column gives back: digits lost, exponent form.
    const lossy = rows([0, 15, 30, 45]).map((r) => ({ ...r, reserve_eth: Number(r.reserve_eth), reserve_token: Number(r.reserve_token) }));
    assert.equal(P.referencePrice(lossy, NOW), null);
  });

  it('read only this chain and token', async () => {
    const other = stored.map((r) => ({ ...r, chain_id: 1 }));
    const provider = pairProvider({ reserveToken: RES.token, reserveEth: RES.eth });
    const out = await P.poolPriceCheck({ supabase: snapshotDb(other), provider, chainId: 91342, pool, nowMs: NOW });
    assert.deepEqual(out, { ok: false, reason: 'no_reference' });
  });

  it('fail on a pumped pool', async () => {
    const provider = pairProvider({ reserveToken: RES.token / 10n, reserveEth: RES.eth * 10n });
    const out = await P.poolPriceCheck({ supabase: snapshotDb(stored), provider, chainId: 91342, pool, nowMs: NOW });
    assert.deepEqual(out, { ok: false, reason: 'price_moved' });
  });

  it('fail, never throw, when the chain or the database cannot be read', async () => {
    const down = pairProvider({ reserveToken: RES.token, reserveEth: RES.eth, fail: true });
    assert.deepEqual(await P.poolPriceCheck({ supabase: snapshotDb(stored), provider: down, chainId: 91342, pool, nowMs: NOW }), {
      ok: false,
      reason: 'unreadable',
    });
    const up = pairProvider({ reserveToken: RES.token, reserveEth: RES.eth });
    assert.deepEqual(
      await P.poolPriceCheck({ supabase: snapshotDb(stored, { error: { message: 'down' } }), provider: up, chainId: 91342, pool, nowMs: NOW }),
      { ok: false, reason: 'no_reference' }
    );
  });

  it('fail with no pool (a token-to-token pair, or a token with no verified pool)', async () => {
    const provider = pairProvider({ reserveToken: RES.token, reserveEth: RES.eth });
    assert.deepEqual(
      await P.swapPriceCheck({ supabase: snapshotDb(stored), provider, chainId: 91342, pool: null, inIsNative: true, amountIn: 1n, amountOutMin: 1n }),
      { ok: false, reason: 'no_pool' }
    );
    assert.deepEqual(await P.poolPriceCheck({ supabase: snapshotDb(stored), provider, chainId: 91342, pool: null }), {
      ok: false,
      reason: 'no_pool',
    });
  });
});
