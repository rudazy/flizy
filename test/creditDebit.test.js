/**
 * Credit is spent atomically, or not at all.
 *
 * The bug: the send path read balance_eth, went to the chain, then wrote back an
 * absolute value worked out from that stale read. Two sends across two channels
 * both read the same starting balance and the second write overwrote the first,
 * so one debit vanished and the user spent credit they did not have.
 *
 * The debits below are fired concurrently on purpose. Awaited in sequence they
 * would pass against the broken code too.
 *
 * Run: node --test test/creditDebit.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

const USER = 'user-1';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const { debitUserCredit, creditUserCredit } = require('../lib/credit');

function seed(balance) {
  fake = createFakeSupabase({
    users: [{ id: USER, phone: '2348000000000', balance_eth: balance, is_admin: false }],
  });
}

const balanceNow = () => Number(fake.db.tables.users[0].balance_eth);

beforeEach(() => seed(1));

describe('concurrent debits both land', () => {
  it('applies both, rather than losing one to a stale write', async () => {
    const [a, b] = await Promise.all([
      debitUserCredit(USER, '0.4'),
      debitUserCredit(USER, '0.4'),
    ]);

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    // The whole point: 1 - 0.4 - 0.4, not 1 - 0.4.
    assert.equal(Number(balanceNow().toFixed(10)), 0.2);
  });

  it('lets only one through when the balance covers a single debit', async () => {
    seed(0.5);
    const [a, b] = await Promise.all([
      debitUserCredit(USER, '0.4'),
      debitUserCredit(USER, '0.4'),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    assert.equal(winners.length, 1, 'one debit must be refused');
    assert.equal(Number(balanceNow().toFixed(10)), 0.1);
  });

  it('never drives the balance negative under load', async () => {
    seed(1);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => debitUserCredit(USER, '0.3'))
    );
    const okCount = results.filter((r) => r.ok).length;
    assert.equal(okCount, 3, 'only three 0.3 debits fit in 1.0');
    assert.ok(balanceNow() >= 0);
    assert.equal(Number(balanceNow().toFixed(10)), 0.1);
  });
});

describe('the guard', () => {
  it('refuses a debit larger than the balance and leaves it untouched', async () => {
    const result = await debitUserCredit(USER, '5');
    assert.equal(result.ok, false);
    assert.equal(result.balanceEth, 1);
    assert.equal(balanceNow(), 1);
  });

  it('allows spending the balance down to exactly zero', async () => {
    const result = await debitUserCredit(USER, '1');
    assert.equal(result.ok, true);
    assert.equal(balanceNow(), 0);
  });

  it('reports the current balance when it refuses, for the error message', async () => {
    seed(0.25);
    const result = await debitUserCredit(USER, '0.9');
    assert.equal(result.ok, false);
    assert.equal(result.balanceEth, 0.25);
  });

  it('rejects a non-positive amount instead of quietly crediting', async () => {
    await assert.rejects(() => debitUserCredit(USER, '0'), /greater than 0/);
    await assert.rejects(() => debitUserCredit(USER, '-1'), /greater than 0/);
    assert.equal(balanceNow(), 1);
  });

  it('returns not-ok for an unknown user', async () => {
    const result = await debitUserCredit('nobody', '0.1');
    assert.equal(result.ok, false);
  });
});

describe('returning a reservation', () => {
  it('puts the amount back', async () => {
    await debitUserCredit(USER, '0.4');
    assert.equal(Number(balanceNow().toFixed(10)), 0.6);
    await creditUserCredit(USER, '0.4');
    assert.equal(Number(balanceNow().toFixed(10)), 1);
  });

  it('is unguarded, so a release cannot fail the way a spend can', async () => {
    await debitUserCredit(USER, '1');
    const result = await creditUserCredit(USER, '1');
    assert.equal(result.ok, true);
    assert.equal(balanceNow(), 1);
  });
});
