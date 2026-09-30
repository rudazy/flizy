/**
 * Site swaps: which need the password, and the floor a swap may fill at.
 *
 * Run: node --test test/swapGate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let gate;

const DEX = {
  wrappedNative: '0x1111111111111111111111111111111111111111',
  flz: '0x308be8f71DA695f18E70D2243a446e1fD1566BA6',
};
const OTHER = '0x2222222222222222222222222222222222222222';

describe('swapNeedsPassword', () => {
  it('loads', async () => {
    gate = await import('../web/lib/swapGate.ts');
  });

  it('does not ask on ETH, WETH or FLZ, in any casing', () => {
    assert.equal(gate.swapNeedsPassword([null, DEX.flz], DEX), false);
    assert.equal(gate.swapNeedsPassword([DEX.flz.toLowerCase(), null], DEX), false);
    assert.equal(gate.swapNeedsPassword([null, DEX.wrappedNative], DEX), false);
  });

  it('asks when either side is any other token', () => {
    assert.equal(gate.swapNeedsPassword([null, OTHER], DEX), true);
    assert.equal(gate.swapNeedsPassword([OTHER, null], DEX), true);
  });
});

describe('bindAmountOutMin', () => {
  it('keeps the confirmed minimum when it is stricter', () => {
    assert.equal(gate.bindAmountOutMin(90n, 95n), 95n);
  });

  it('keeps the server minimum when it is stricter, or nothing was confirmed', () => {
    assert.equal(gate.bindAmountOutMin(90n, 80n), 90n);
    assert.equal(gate.bindAmountOutMin(90n, null), 90n);
  });
});
