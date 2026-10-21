/**
 * Payment metrics: who pays, and who pays the same person again.
 *
 * Run: node --test test/paymentMetrics.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { paymentMetrics } = require('../lib/paymentMetrics');

const now = Date.parse('2026-10-21T12:00:00.000Z');
const ago = (d) => new Date(now - d * 86400e3).toISOString();
const pay = (account_id, to_address, days, phone = 'site') => ({ account_id, to_address, created_at: ago(days), phone });

describe('payment metrics', () => {
  it('counts payers per window, repeat pairs, and outside wallets apart', () => {
    const m = paymentMetrics(
      [
        pay('a', '0xAA', 1),
        pay('a', '0xaa', 10), // same pair, other case: a repeat
        pay('a', '0xbb', 2),
        pay('b', '0xaa', 20),
        pay('c', '0xcc', 31), // outside 30 days
        pay(null, '0xaa', 3, 'external'),
        pay(null, '0xaa', 3, 'site'), // no payer and not external: ignored
      ],
      now
    );
    assert.deepEqual(m, {
      weeklyActivePayers: 1,
      monthlyActivePayers: 2,
      repeatPairs: 1,
      payments7d: 2,
      payments30d: 4,
      externalPayments30d: 1,
    });
  });

  it('is all zeros with nothing to count', () => {
    assert.deepEqual(paymentMetrics([], now), {
      weeklyActivePayers: 0, monthlyActivePayers: 0, repeatPairs: 0, payments7d: 0, payments30d: 0, externalPayments30d: 0,
    });
  });

  it('is read by a script that prints aggregates only', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'payment-metrics.js'), 'utf8');
    assert.match(script, /\.select\('account_id, to_address, created_at, phone'\)/);
    assert.doesNotMatch(script, /console\.log\([^)]*rows\b|to_address\}|account_id\}/);
    assert.doesNotMatch(script, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });
});
