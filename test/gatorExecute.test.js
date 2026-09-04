/**
 * HybridDeleGator execute encoding (no live chain).
 *
 * Run: node --test test/gatorExecute.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { encodeExecuteCall, packU128, pointerIsGator } = require('../lib/gatorExecute');

describe('encodeExecuteCall', () => {
  it('encodes a native send', () => {
    const data = encodeExecuteCall(
      '0x0000000000000000000000000000000000000001',
      1000n,
      '0x'
    );
    assert.match(data, /^0x/);
    const iface = new ethers.Interface([
      'function execute((address target, uint256 value, bytes callData))',
    ]);
    const decoded = iface.decodeFunctionData('execute', data);
    assert.equal(decoded[0].target, '0x0000000000000000000000000000000000000001');
    assert.equal(decoded[0].value, 1000n);
  });
});

describe('packU128', () => {
  it('packs two uint128 values into 32 bytes', () => {
    const packed = packU128(1n, 2n);
    assert.equal(packed.length, 66);
  });
});

describe('pointerIsGator', () => {
  it('returns false for a missing or non-address pointer', () => {
    assert.equal(pointerIsGator('acct', null), false);
    assert.equal(pointerIsGator('acct', 'not-an-address'), false);
  });
});
