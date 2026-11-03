/**
 * The Explore row's 24 hours (web/lib/priceSeries.ts and web/lib/tokenRows.ts).
 *
 * What is pinned: the line carries the price forward between trades and steps
 * on each one; with no trade it is flat at the current price; a listed token
 * never gets an empty line while a price is known; the change compares now
 * with the last price before the window (or the first trade, for a pool that
 * opened inside it); one trade is counted and shown as one trade; the rows
 * use the index when it is there and the chain's prints when it is not.
 *
 * Run: node --test test/priceSeries.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let S;
let R;
before(async () => {
  S = await import('../web/lib/priceSeries.ts');
  R = await import('../web/lib/tokenRows.ts');
});

const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;

describe('daySeries', () => {
  it('is flat at the current price when nothing traded, and says so', () => {
    const s = S.daySeries([], 0, NOW, 0.002);
    assert.equal(s.spark.length, S.SPARK_POINTS);
    assert.ok(s.spark.every((v) => v === 0.002));
    assert.equal(s.change24hPct, null);
    assert.equal(s.trades24h, 0);
  });

  it('is flat at the last known price when the only price is from before the window', () => {
    const s = S.daySeries([{ time: NOW - 2 * DAY, priceEth: 0.5 }], 0, NOW, null);
    assert.ok(s.spark.every((v) => v === 0.5));
  });

  it('is empty only when no price is known at all', () => {
    assert.deepEqual(S.daySeries([], 0, NOW, null).spark, []);
  });

  it('carries the price forward and steps on each trade', () => {
    const prices = [
      { time: NOW - 2 * DAY, priceEth: 1 },
      { time: NOW - 12 * 3600, priceEth: 2 },
      { time: NOW - 900, priceEth: 3 },
    ];
    const s = S.daySeries(prices, 2, NOW, 3);
    const half = S.SPARK_POINTS / 2;
    assert.ok(s.spark.slice(0, half - 1).every((v) => v === 1), 'held at the opening price');
    assert.equal(s.spark[half - 1], 2, 'steps when the trade lands');
    assert.equal(s.spark[S.SPARK_POINTS - 2], 2, 'held between trades');
    assert.equal(s.spark[S.SPARK_POINTS - 1], 3);
    assert.equal(s.change24hPct, 200);
    assert.equal(s.trades24h, 2);
  });

  it('compares with the last price before the window, not the first inside it', () => {
    const s = S.daySeries(
      [
        { time: NOW - 3 * DAY, priceEth: 9 },
        { time: NOW - 2 * DAY, priceEth: 4 },
        { time: NOW - 3600, priceEth: 5 },
      ],
      1,
      NOW,
      5
    );
    assert.equal(s.change24hPct, 25);
  });

  it('counts a single trade as one, with its change, never as no trades', () => {
    const s = S.daySeries([{ time: NOW - 5 * DAY, priceEth: 2 }, { time: NOW - 600, priceEth: 1 }], 1, NOW, 1);
    assert.equal(s.trades24h, 1);
    assert.equal(s.change24hPct, -50);
    assert.equal(S.tradesLabel(1), '1 trade');
    assert.equal(S.tradesLabel(7), '7 trades');
  });

  it('opens at the first trade for a pool that opened inside the window', () => {
    const s = S.daySeries([{ time: NOW - 10 * 3600, priceEth: 1 }, { time: NOW - 3600, priceEth: 1.5 }], 2, NOW, 1.5);
    assert.equal(s.spark[0], 1);
    assert.equal(s.change24hPct, 50);
  });

  it('ignores prices that are not positive numbers', () => {
    const s = S.daySeries([{ time: NOW - 100, priceEth: 0 }, { time: NOW - 50, priceEth: Number.NaN }], 0, NOW, 0.1);
    assert.ok(s.spark.every((v) => v === 0.1));
  });
});

describe('listTokens', () => {
  const day = (symbol, pair, extra = {}) => ({
    pool: { symbol, name: symbol, pair, priceEth: '0.002', flzPerEth: '500', liquidityEth: '10', marketCapEth: '100' },
    prints: [],
    now: NOW,
    chartError: false,
    ...extra,
  });
  const FLZ_PAIR = '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227';

  it('keeps market cap and liquidity exactly as the pool read them', () => {
    const rows = R.listTokens({ flzDay: day('FLZ', FLZ_PAIR), listedDays: [], indexed: null, watched: [], oneHour: () => ({ change1hPct: 1 }) });
    assert.equal(rows[0].marketCapEth, '100');
    assert.equal(rows[0].liquidityEth, '10');
    assert.equal(rows[0].change1hPct, 1);
  });

  it('takes the 24 hours from the index when it can be read', () => {
    const indexed = { now: NOW, windows: { [FLZ_PAIR.toLowerCase()]: { prices: [{ time: NOW - 2 * DAY, priceEth: 0.001 }, { time: NOW - 60, priceEth: 0.002 }], trades: 3 } } };
    const [flz] = R.listTokens({ flzDay: day('FLZ', FLZ_PAIR), listedDays: [], indexed, watched: [], oneHour: () => ({ change1hPct: null }) });
    assert.equal(flz.trades24h, 3);
    assert.equal(flz.change24hPct, 100);
    assert.equal(flz.spark.length, S.SPARK_POINTS);
  });

  it('uses the index only for a pair it holds, and the chain read for one that is behind', () => {
    const DCAT_PAIR = '0x3083C7Aa86Bc20256439c102156E7fCbe7b91797';
    const indexed = { now: NOW, windows: { [FLZ_PAIR.toLowerCase()]: { prices: [], trades: 2 } } };
    const dcat = day('DCAT', DCAT_PAIR, { prints: [{ time: NOW - 100, priceEth: 0.002, volumeEth: 1 }] });
    const rows = R.listTokens({ flzDay: day('FLZ', FLZ_PAIR), listedDays: [dcat, null, null, null], indexed, watched: [], oneHour: () => ({ change1hPct: null }) });
    assert.equal(rows[0].trades24h, 2, 'FLZ from the index');
    assert.equal(rows[1].trades24h, 1, 'DCAT from its own chain read, not a false zero');
  });

  it('falls back to the chain prints when the index is not there, and drops the count when that read failed', () => {
    const prints = [{ time: NOW - 100, priceEth: 0.002, volumeEth: 1 }];
    const [ok] = R.listTokens({ flzDay: day('FLZ', FLZ_PAIR, { prints }), listedDays: [], indexed: null, watched: [], oneHour: () => ({ change1hPct: null }) });
    assert.equal(ok.trades24h, 1);
    const [failed] = R.listTokens({ flzDay: day('FLZ', FLZ_PAIR, { chartError: true }), listedDays: [], indexed: null, watched: [], oneHour: () => ({ change1hPct: null }) });
    assert.equal(failed.trades24h, null);
    assert.ok(failed.spark.length > 0, 'still a flat line at the pool price');
  });

  it('draws a partial read but never states its undercounted trades', () => {
    const prints = [{ time: NOW - 100, priceEth: 0.002, volumeEth: 1 }];
    const [partial] = R.listTokens({ flzDay: day('FLZ', FLZ_PAIR, { prints, partial: true }), listedDays: [], indexed: null, watched: [], oneHour: () => ({ change1hPct: null }) });
    assert.equal(partial.trades24h, null);
    assert.equal(partial.change24hPct, null);
    assert.equal(partial.spark.length, S.SPARK_POINTS);
  });
});
