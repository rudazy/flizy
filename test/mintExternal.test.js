/**
 * Call-through minting: which public mint function a contract has (found in
 * its bytecode), and the exact call Flizy would send for it.
 *
 * Run: node --test test/mintExternal.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let m;
let ethers;
before(async () => {
  m = await import('../web/lib/mintExternal.ts');
  ethers = await import('ethers');
});

const ART = path.join(__dirname, '..', 'contracts', 'out');
function runtime(file, name) {
  const p = path.join(ART, file, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')).deployedBytecode?.object ?? null;
}

describe('detectMintFns', () => {
  it('finds each supported selector as a PUSH4', () => {
    assert.deepEqual(m.detectMintFns('0x6080604052634e71d92d'), ['claim']);
    assert.deepEqual(m.detectMintFns('0x63a0712d6863_1249c58b'.replace('_', '')), ['mint_qty', 'mint']);
    assert.deepEqual(m.detectMintFns('0x632db11544'), ['public_mint_qty']);
    assert.deepEqual(m.detectMintFns('0x6080'), []);
  });

  it('orders by preference: quantity mints, then claim, then bare mint', () => {
    assert.deepEqual(m.detectMintFns('0x631249c58b634e71d92d632db11544'), ['public_mint_qty', 'claim', 'mint']);
  });

  it('Giwaforge has claim(), a Flizy-native collection has no public mint', (t) => {
    const giwa = runtime('Giwaforge.sol', 'Giwaforge');
    const native = runtime('FlizyCollection.sol', 'FlizyCollection');
    if (!giwa || !native) return t.skip('contracts not built');
    assert.deepEqual(m.detectMintFns(giwa), ['claim']);
    assert.deepEqual(m.detectMintFns(native), [], 'mintTo is minter-only, not a public mint');
  });
});

describe('externalMintCall', () => {
  it('claim is free and one at a time', () => {
    const call = m.externalMintCall('claim', 1, '500');
    assert.equal(call.data, '0x4e71d92d');
    assert.equal(call.value, 0n, 'a price read from the contract never applies to claim()');
    assert.throws(() => m.externalMintCall('claim', 2, null), /one token at a time/);
  });

  it('quantity mints pay price x quantity', () => {
    const call = m.externalMintCall('public_mint_qty', 3, '1000');
    const iface = new ethers.Interface(['function publicMint(uint256)']);
    assert.equal(call.data, iface.encodeFunctionData('publicMint', [3n]));
    assert.equal(call.value, 3000n);
    const mintQty = m.externalMintCall('mint_qty', 2, null);
    assert.equal(mintQty.data.slice(0, 10), '0xa0712d68');
    assert.equal(mintQty.value, 0n, 'unknown price sends nothing; the simulation decides');
  });

  it('bare mint() is one token', () => {
    assert.equal(m.externalMintCall('mint', 1, '7').value, 7n);
    assert.throws(() => m.externalMintCall('mint', 2, '7'));
  });
});

describe('revertReason', () => {
  it('reads Error(string), else a plain sentence', () => {
    const data = new ethers.AbiCoder().encode(['string'], ['Sale not active']);
    assert.equal(m.revertReason({ data: `0x08c379a0${data.slice(2)}` }), 'Sale not active');
    assert.equal(m.revertReason({ reason: 'AlreadyClaimed' }), 'AlreadyClaimed');
    assert.equal(m.revertReason({ data: '0x1234abcd' }), 'The contract refused this mint for your wallet.');
    assert.equal(m.revertReason(null), 'The contract refused this mint for your wallet.');
    assert.equal(m.revertReason({ reason: 'x'.repeat(5000) }).length, 200, 'contract-chosen text is capped');
  });
});
