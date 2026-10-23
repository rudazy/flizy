/**
 * A chat payment whose outcome was unknown is told "pending" by the engine,
 * and the reconciler messages the account once the transaction settles.
 *
 * What is pinned: the notice text for both outcomes, that only an account's
 * own outgoing payments get one, that a relayer send (not an EntryPoint
 * UserOp) settles by its receipt, and that one settle sends one message.
 *
 * Run: node --test test/pendingPaymentNotice.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const { runReconcileTick, resetFlaggedCursors, settledPaymentNotice, SETTLE_AFTER_MS } = require('../lib/reconcile');

const NOW = Date.parse('2026-10-24T12:00:00Z');
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const DELEGATION_MANAGER = '0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B';
const HASH = '0x' + 'ab'.repeat(32);
const link = (h) => `https://explorer.test/tx/${h}`;

let notified;
let receipt;

function deps() {
  return {
    supabase: fake.client,
    now: NOW,
    entryPoint: EP,
    gatorOf: () => '0x' + '99'.repeat(20),
    userOpSucceeded: () => true,
    provider: { getTransactionReceipt: async () => receipt },
    alertAdmins: async () => {},
    markRequestPaid: async () => {},
    releaseRequestProcessing: async () => {},
    creditBack: async () => {},
    createClaim: async () => ({ claim: null }),
    notifyAccount: async (id, text) => notified.push([id, text]),
    notifyClaimRecipient: async () => {},
    explorerUrl: link,
  };
}

const row = (over = {}) => ({
  id: 't1',
  account_id: 'acct-1',
  user_id: 'u1',
  status: 'submitted',
  tx_hash: HASH,
  kind: 'transfer',
  direction: 'out',
  asset: 'TUSD',
  amount_eth: '5',
  payment_request_id: null,
  created_at: new Date(NOW - SETTLE_AFTER_MS - 1000).toISOString(),
  error: null,
  ...over,
});

beforeEach(() => {
  resetFlaggedCursors();
  notified = [];
  receipt = null;
});

describe('the notice text', () => {
  it('says it went through, with the explorer link, or that the money did not move', () => {
    assert.equal(settledPaymentNotice(row(), 'success', link), `Your pending payment of 5 tUSD went through.\n${link(HASH)}`);
    assert.equal(settledPaymentNotice(row({ asset: 'ETH', amount_eth: '0.01' }), 'failed', link), 'Your pending payment of 0.01 ETH did not go through. The money did not move.');
  });

  it('is only for an account\'s own outgoing payments', () => {
    assert.equal(settledPaymentNotice(row({ account_id: null }), 'success', link), null);
    assert.equal(settledPaymentNotice(row({ kind: 'swap' }), 'success', link), null);
    assert.equal(settledPaymentNotice(row({ direction: 'in' }), 'success', link), null);
  });
});

describe('the reconciler sends it once the payment settles', () => {
  it('a relayer send that confirmed: one "went through" message', async () => {
    fake = createFakeSupabase({ transfers: [row()], limit_orders: [], claim_hold_attempts: [], claims: [] });
    receipt = { status: 1, to: DELEGATION_MANAGER, logs: [] };
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'confirmed');
    assert.deepEqual(notified, [['acct-1', `Your pending payment of 5 tUSD went through.\n${link(HASH)}`]]);
    await runReconcileTick(deps());
    assert.equal(notified.length, 1, 'settled once, told once');
  });

  it('a send that reverted: one "did not go through" message', async () => {
    fake = createFakeSupabase({ transfers: [row()], limit_orders: [], claim_hold_attempts: [], claims: [] });
    receipt = { status: 0, to: DELEGATION_MANAGER, logs: [] };
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    assert.match(notified[0][1], /did not go through/);
  });

  it('no receipt yet: no message', async () => {
    fake = createFakeSupabase({ transfers: [row()], limit_orders: [], claim_hold_attempts: [], claims: [] });
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'submitted');
    assert.deepEqual(notified, []);
  });
});
