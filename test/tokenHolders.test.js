/**
 * Top-holder math. Amounts stay exact until the last displayed digit.
 *
 * Run: node --test test/tokenHolders.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const UNIT = 10n ** 18n;
let holders;

describe('token holders', () => {
  it('loads', async () => {
    holders = await import('../web/lib/tokenHolders.ts');
  });

  it('keeps ten addresses from the explorer shape and drops junk', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      address: { hash: `0x${index.toString(16).padStart(40, '0')}` },
      value: '1',
    }));
    items.push({ address: { hash: 'not-an-address' }, value: '9' });
    items.push({ address: { hash: items[0].address.hash }, value: '9' });
    const found = holders.holderAddresses({ items });
    assert.equal(found.length, 12);
    assert.equal(holders.holderAddresses({ items }, 10).length, 10);
    assert.deepEqual(holders.holderAddresses({}), []);
    assert.equal(holders.holderCount({ holders_count: '43' }), 43);
    assert.equal(holders.holderCount({ holders_count: 'nope' }), null);
  });

  it('ranks by the chain balance and puts the top share over the ten', () => {
    const pair = `0x${'ab'.repeat(20)}`;
    const rows = Array.from({ length: 12 }, (_, index) => ({
      address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      balance: BigInt(12 - index) * UNIT,
    }));
    rows[2].address = pair;
    rows.push({ address: `0x${'11'.repeat(20)}`, balance: 0n });
    const supply = 100n * UNIT;
    const view = holders.presentHolders(rows, supply, pair);
    assert.equal(view.holders.length, 10);
    assert.equal(view.holders[0].amount, '12');
    assert.equal(view.holders[2].label, 'Pool');
    assert.equal(view.holders[1].label, null);
    const held = rows
      .slice()
      .sort((a, b) => (a.balance > b.balance ? -1 : 1))
      .slice(0, 10)
      .reduce((sum, row) => sum + row.balance, 0n);
    assert.equal(view.topShare, holders.percentOf(held, supply));
    assert.match(view.topShare, /^\d+\.\d%$/);
  });

  it('does not invent a share when supply is zero', () => {
    const view = holders.presentHolders(
      [{ address: `0x${'22'.repeat(20)}`, balance: UNIT }],
      0n,
      null
    );
    assert.equal(view.topShare, null);
    assert.equal(view.holders[0].amount, '1');
  });
});
