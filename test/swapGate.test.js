/**
 * Site swaps: which tokens are unverified, and the floor a swap may fill at.
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

describe('isUnverifiedSwap', () => {
  it('loads', async () => {
    gate = await import('../web/lib/swapGate.ts');
  });

  it('treats ETH, WETH and FLZ as verified, in any casing', () => {
    assert.equal(gate.isUnverifiedSwap([null, DEX.flz], DEX), false);
    assert.equal(gate.isUnverifiedSwap([DEX.flz.toLowerCase(), null], DEX), false);
    assert.equal(gate.isUnverifiedSwap([null, DEX.wrappedNative], DEX), false);
  });

  it('treats a listed token as verified for swaps, in any casing', () => {
    assert.equal(gate.isUnverifiedSwap([null, '0x8ca7a8f78abc8da471df82be4f374e1661e34473'], DEX), false);
    assert.equal(gate.isUnverifiedSwap(['0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d', null], DEX), false);
    assert.equal(gate.isUnverifiedSwap(['0x58fB4D3DA82F5d610ad36E6e39e674C17B32Ffd1', OTHER], DEX), true);
  });

  it('flags any other token on either side', () => {
    assert.equal(gate.isUnverifiedSwap([null, OTHER], DEX), true);
    assert.equal(gate.isUnverifiedSwap([OTHER, null], DEX), true);
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

describe('POST /api/swap/execute', () => {
  // The handler reads a Next request cookie and cannot be imported here, so its
  // source is checked. The gate itself is exercised in test/pinRouteGate.test.js.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'app', 'api', 'swap', 'execute', 'route.ts'),
    'utf8'
  );

  it('asks for the password on every swap, not only unverified ones', () => {
    const call = src.indexOf('await requirePassword(');
    assert.ok(call > 0, 'requirePassword is not called');
    const before = src.slice(0, call);
    const lastLine = before.slice(before.lastIndexOf('\n') + 1);
    // Four spaces is the handler's top level inside its try; anything deeper is
    // inside a block, which is where a condition would put it.
    assert.match(lastLine, /^ {4}const auth = $/, 'requirePassword must not sit inside a condition');
  });

  it('refuses before any chain work or the transaction lock', () => {
    const gate = src.indexOf('await requirePassword(');
    const refusal = src.indexOf('if (!auth.ok)', gate);
    assert.ok(refusal > gate);
    for (const later of ['readErc20Decimals(provider', 'tryAccountTxLock(', 'quoteSwap(', 'executeSwap(']) {
      assert.ok(src.indexOf(later) > refusal, `${later} runs before the password is checked`);
    }
  });
});
