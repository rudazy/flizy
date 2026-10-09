/**
 * Pool prints become candles only when a swap actually happened.
 *
 * Run: node --test test/tokenMarket.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let market;
let format;

before(async () => {
  market = await import('../web/lib/tokenMarket.ts');
  format = await import('../web/lib/tokenFormat.ts');
});

const ONE = 10n ** 18n;

describe('token market prints', () => {
  it('prices a buy as ETH spent over FLZ received', () => {
    const print = market.printFromSwap({
      flzIsToken0: true,
      amount0In: 0n,
      amount1In: ONE,
      amount0Out: 1000n * ONE,
      amount1Out: 0n,
      time: 1_700_000_000,
    });
    assert.ok(print);
    assert.ok(Math.abs(print.priceEth - 0.001) < 1e-12);
    assert.ok(Math.abs(print.volumeEth - 1) < 1e-12);
  });

  it('prices a sell when FLZ is token1', () => {
    const print = market.printFromSwap({
      flzIsToken0: false,
      amount0In: 0n,
      amount1In: 500n * ONE,
      amount0Out: ONE / 2n,
      amount1Out: 0n,
      time: 1_700_000_100,
    });
    assert.ok(print);
    assert.ok(Math.abs(print.priceEth - 0.001) < 1e-12);
  });

  it('drops a swap that moved nothing', () => {
    assert.equal(
      market.printFromSwap({
        flzIsToken0: true,
        amount0In: 0n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 0n,
        time: 10,
      }),
      null
    );
  });

  it('buckets two prints into one candle and keeps the later close', () => {
    const candles = market.buildCandles(
      [
        { time: 100, priceEth: 1, volumeEth: 2 },
        { time: 110, priceEth: 3, volumeEth: 4 },
        { time: 400, priceEth: 2, volumeEth: 1 },
      ],
      60
    );
    assert.equal(candles.length, 2);
    assert.equal(candles[0].open, 1);
    assert.equal(candles[0].high, 3);
    assert.equal(candles[0].low, 1);
    assert.equal(candles[0].close, 3);
    assert.equal(candles[0].volumeEth, 6);
    assert.equal(candles[1].time, 360);
  });

  it('refuses a change from a single print', () => {
    assert.equal(market.changePct([{ time: 1, priceEth: 2, volumeEth: 1 }]), null);
    const change = market.changePct([
      { time: 1, priceEth: 2, volumeEth: 1 },
      { time: 2, priceEth: 1.5, volumeEth: 1 },
    ]);
    assert.ok(change != null);
    assert.ok(Math.abs(change + 25) < 1e-9);
    assert.equal(format.formatPct(change), '-25.00%');
    assert.equal(format.formatPct(1.2), '+1.20%');
    assert.equal(format.formatPct(null), null);
    assert.equal(format.formatEthDisplay('1.5'), '1.5');
    assert.equal(format.formatEthDisplay(null), null);
  });
});

describe('reading a day of the pool', () => {
  it('names the side of a trade and how much FLZ moved', () => {
    const buy = market.printFromSwap({ flzIsToken0: true, amount0In: 0n, amount1In: ONE, amount0Out: 1000n * ONE, amount1Out: 0n, time: 1 });
    const sell = market.printFromSwap({ flzIsToken0: true, amount0In: 500n * ONE, amount1In: 0n, amount0Out: 0n, amount1Out: ONE / 2n, time: 2 });
    assert.equal(buy.side, 'buy');
    assert.equal(buy.flzAmount, 1000);
    assert.equal(sell.side, 'sell');
    assert.equal(sell.flzAmount, 500);
  });

  it('splits a block range into chunks GIWA accepts, with no gap and no overlap', () => {
    const chunks = market.blockChunks(1000, 30_999, 9000);
    assert.deepEqual(chunks, [
      [1000, 9999],
      [10000, 18999],
      [19000, 27999],
      [28000, 30999],
    ]);
    assert.deepEqual(market.blockChunks(5, 5, 9000), [[5, 5]]);
    assert.deepEqual(market.blockChunks(10, 9, 9000), []);
    assert.throws(() => market.blockChunks(0, 10, 0));
  });

  it('offers the three ranges a day of reads covers', () => {
    assert.deepEqual(market.CHART_RANGES, ['1h', '4h', '1d']);
    assert.equal(market.isChartRange('1d'), true);
    assert.equal(market.isChartRange('all'), false);
    assert.equal(market.rangeSeconds('1d'), 86400);
  });

  it('works out the 24-hour figures, and invents none for a quiet day', () => {
    const stats = market.dayStats([
      { time: 1, priceEth: 0.002, volumeEth: 0.1, side: 'buy' },
      { time: 2, priceEth: 0.003, volumeEth: 0.2, side: 'buy' },
      { time: 3, priceEth: 0.0025, volumeEth: 0.05, side: 'sell' },
    ]);
    assert.equal(stats.high, 0.003);
    assert.equal(stats.low, 0.002);
    assert.ok(Math.abs(stats.volumeEth - 0.35) < 1e-12);
    assert.equal(stats.trades, 3);
    assert.equal(stats.buys, 2);
    assert.equal(stats.sells, 1);
    assert.ok(Math.abs(stats.changePct - 25) < 1e-9);
    assert.deepEqual(market.dayStats([]), { high: null, low: null, volumeEth: 0, trades: 0, buys: 0, sells: 0, changePct: null });
  });

  it('finds the trader in the FLZ transfers, not the address that sent the transaction', () => {
    const pair = '0x' + 'aa'.repeat(20);
    const router = '0x' + 'bb'.repeat(20);
    const trader = '0x' + 'cc'.repeat(20);
    // Buy routed through the router: pool -> router -> trader.
    const bought = market.traderFromTransfers(
      [
        { from: pair, to: router },
        { from: router, to: trader },
      ],
      'buy',
      [pair, router]
    );
    assert.equal(bought.toLowerCase(), trader);
    // Sell: trader -> pool.
    assert.equal(market.traderFromTransfers([{ from: trader, to: pair }], 'sell', [pair, router]).toLowerCase(), trader);
    assert.equal(market.traderFromTransfers([{ from: pair, to: router }], 'buy', [pair, router]), null);
  });
});
