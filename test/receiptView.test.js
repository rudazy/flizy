/**
 * How a shared receipt prints its figures: the amount, the dollar line, the
 * date, the shortened hash and the line under each name.
 *
 * Run: node --test test/receiptView.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let v;
before(async () => {
  v = await import('../web/lib/receiptView.ts');
});

describe('receipt figures', () => {
  it('prints at least two decimals and at most six', () => {
    assert.equal(v.receiptAmount('2'), '2.00');
    assert.equal(v.receiptAmount('0.0125'), '0.0125');
    assert.equal(v.receiptAmount('1500'), '1,500.00');
    assert.equal(v.receiptAmount('not a number'), 'not a number');
  });

  it('gives tUSD one to one and ETH only with a rate', () => {
    assert.equal(v.receiptUsd('2', 'tUSD', null), '≈ $2.00');
    assert.equal(v.receiptUsd('0.5', 'ETH', 3000), '≈ $1,500.00');
    assert.equal(v.receiptUsd('0.5', 'ETH', null), null);
    assert.equal(v.receiptUsd('10', 'FLZ', 3000), null);
    assert.equal(v.receiptUsd('0', 'tUSD', null), null);
  });

  it('dates in UTC and keeps both ends of the hash', () => {
    assert.equal(v.receiptWhen('2026-10-22T10:42:00Z'), '22 Oct 2026, 10:42 UTC');
    const hash = '0x2d7a' + 'ab'.repeat(27) + '91ed0769';
    assert.equal(v.receiptHash(hash), '0x2d7a...91ed0769');
    assert.equal(v.receiptHash('0x1234'), '0x1234');
  });

  it('names who holds each side', () => {
    assert.equal(v.partyNote('flizy', 'from'), 'Flizy wallet');
    assert.equal(v.partyNote('flizy', 'to'), 'Flizy user');
    assert.equal(v.partyNote('wallet', 'to'), 'Outside wallet');
  });
});
