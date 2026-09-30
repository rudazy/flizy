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
