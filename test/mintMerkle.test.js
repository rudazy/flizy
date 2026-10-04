/**
 * Allowlist Merkle tree. The fixed vector here is the one
 * contracts/test/FlizyDrop.t.sol checks (test_merkle_matches_js_vector), so the
 * server and the contract cannot disagree about a proof.
 *
 * Run: node --test test/mintMerkle.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let m;
before(async () => {
  m = await import('../web/lib/mintMerkle.ts');
});

const C = '0x000000000000000000000000000000000000c011';
const A1 = '0x00000000000000000000000000000000000000a1';
const A2 = '0x00000000000000000000000000000000000000a2';
const A3 = '0x00000000000000000000000000000000000000a3';
const LIST = [
  { wallet: A1, allowance: 1 },
  { wallet: A2, allowance: 2 },
  { wallet: A3, allowance: 3 },
];
const ROOT = '0x0a67207a0fc53d2a411e10fa97b7840e08ce1c038fc78808e5d5230688272dde';

describe('shared vector with FlizyDrop.t.sol', () => {
  it('root', () => {
    assert.equal(m.allowlistRoot(C, LIST), ROOT);
  });

  it('proofs', () => {
    assert.deepEqual(m.allowlistProof(C, LIST, LIST[1]), [
      '0xb17fb065cd243837bb254e555cfbf6d522fed8285a0ee7ae018ce6962cec456a',
    ]);
    assert.deepEqual(m.allowlistProof(C, LIST, LIST[0]), [
      '0x2333ef30dd0d345105d9d9b5c25055a895ea0b2d02e5e8f9499600f4b590b181',
      '0x80fa29b13dbf21561e7e320db99cbc6aa966304977cab7c686a1fdff724e7372',
    ]);
  });
});

describe('tree', () => {
  it('every entry verifies against the root', () => {
    for (const e of LIST) {
      const proof = m.allowlistProof(C, LIST, e);
      assert.ok(m.verifyProof(proof, ROOT, m.leafHash(C, e.wallet, e.allowance)));
    }
  });

  it('a different allowance or wallet has no proof', () => {
    assert.equal(m.allowlistProof(C, LIST, { wallet: A1, allowance: 5 }), null);
    assert.equal(m.allowlistProof(C, LIST, { wallet: '0x00000000000000000000000000000000000000b1', allowance: 1 }), null);
  });

  it('a proof does not verify for another collection', () => {
    const proof = m.allowlistProof(C, LIST, LIST[0]);
    const other = '0x000000000000000000000000000000000000c022';
    assert.equal(m.verifyProof(proof, ROOT, m.leafHash(other, A1, 1)), false);
  });

  it('order and duplicates do not change the root', () => {
    const shuffled = [LIST[2], LIST[0], LIST[1], LIST[0]];
    assert.equal(m.allowlistRoot(C, shuffled), ROOT);
  });

  it('address case does not change the leaf', () => {
    assert.equal(m.leafHash(C, A1, 1), m.leafHash(C.toUpperCase().replace('0X', '0x'), A1, 1));
  });

  it('an empty list is the zero root; one entry is its own leaf', () => {
    assert.equal(m.allowlistRoot(C, []), `0x${'0'.repeat(64)}`);
    assert.equal(m.allowlistRoot(C, [LIST[0]]), m.leafHash(C, A1, 1));
    assert.deepEqual(m.allowlistProof(C, [LIST[0]], LIST[0]), []);
  });

  it('a larger list still proves every entry', () => {
    const big = Array.from({ length: 37 }, (_, i) => ({
      wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      allowance: (i % 4) + 1,
    }));
    const root = m.allowlistRoot(C, big);
    for (const e of big) {
      assert.ok(m.verifyProof(m.allowlistProof(C, big, e), root, m.leafHash(C, e.wallet, e.allowance)));
    }
  });
});
