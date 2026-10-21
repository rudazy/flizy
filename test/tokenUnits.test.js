/**
 * The deposit dialog's amount maths: what the person sees is what the wallet
 * signs, and a share of a balance never rounds up past it.
 *
 * Run: node --test test/tokenUnits.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let u;
before(async () => {
  u = await import('../web/lib/tokenUnits.ts');
});

describe('toUnits', () => {
  it('reads plain amounts exactly', () => {
    assert.equal(u.toUnits('1.5', 18), 1500000000000000000n);
    assert.equal(u.toUnits('0.000001', 6), 1n);
    assert.equal(u.toUnits('.5', 6), 500000n);
    assert.equal(u.toUnits('7', 0), 7n);
  });

  it('refuses what is not a plain amount, or more decimals than the token has', () => {
    for (const bad of ['', '.', '-1', '1e3', '1,5', 'abc', '1.2.3']) assert.equal(u.toUnits(bad, 18), null, bad);
    assert.equal(u.toUnits('0.0000001', 6), null);
  });
});

describe('fromUnits', () => {
  it('rounds down and drops trailing zeros', () => {
    assert.equal(u.fromUnits(1999999999999999999n, 18, 6), '1.999999');
    assert.equal(u.fromUnits(1500000000000000000n, 18, 6), '1.5');
    assert.equal(u.fromUnits(0n, 18, 6), '0');
    assert.equal(u.fromUnits(123456789n, 6, 6), '123.456789');
  });

  it('round-trips with toUnits at full precision', () => {
    const units = 123456789012345678n;
    assert.equal(u.toUnits(u.fromUnits(units, 18, 18), 18), units);
  });
});

describe('shareOf', () => {
  it('takes a share rounded down, never past the balance', () => {
    assert.equal(u.shareOf(1000n, 50), 500n);
    assert.equal(u.shareOf(999n, 33.33), 332n);
    assert.equal(u.shareOf(1000n, 100), 1000n);
    assert.equal(u.shareOf(1000n, 150), 1000n);
    assert.equal(u.shareOf(1000n, -5), 0n);
  });
});
