/**
 * The Max button never fills in more than the wallet holds.
 *
 * Run: node --test test/tokenFormat.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let fmt;

describe('maxSpend', () => {
  it('loads', async () => {
    fmt = await import('../web/lib/tokenFormat.ts');
  });

  it('truncates, never rounds up past the balance', () => {
    assert.equal(fmt.maxSpend('1.2345679', false), '1.234567');
    assert.equal(fmt.maxSpend('12345.9999999', false), '12345.999999');
    assert.equal(fmt.maxSpend('0.0009999999', false), '0.000999999');
  });

  it('keeps plain decimals for tiny balances, never exponent notation', () => {
    assert.equal(fmt.maxSpend('0.00000000012345678', false), '0.000000000123456');
  });

  it('leaves the gas remainder on an ETH spend', () => {
    assert.equal(fmt.maxSpend('0.1234567', true), '0.123376');
    assert.equal(fmt.maxSpend('0.00008', true), null);
  });

  it('refuses nothing to spend and input that is not a decimal', () => {
    assert.equal(fmt.maxSpend('0', false), null);
    assert.equal(fmt.maxSpend(null, false), null);
    assert.equal(fmt.maxSpend('1e-7', false), null);
    assert.equal(fmt.maxSpend('abc', false), null);
  });
});
