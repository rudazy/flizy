/**
 * The reconciler (lib/reconcile.js) settles sends whose outcome was unknown,
 * from their receipt, by hash. Every status change is compare-and-set; nothing
 * is guessed when there is no receipt.
 *
 * Run: node --test test/reconcile.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const {
  runReconcileTick,
  resetFlaggedCursors,
  UNKNOWN_AFTER_MS,
  SETTLE_AFTER_MS,
  SENDING_STALE_MS,
  NO_RECEIPT_NOTE,
  LIMIT_NO_RECEIPT_NOTE,
  FLAGGED_BATCH,
} = require('../lib/reconcile');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const H = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const ACCOUNT = 'acct-r';
const GATOR = '0x9999999999999999999999999999999999999999';

/** Receipts by hash: 'success', 'reverted' (inner), 'outer-failed', or absent. */
let receipts;
let effects;

function deps(extra = {}) {
  return {
    supabase: fake.client,
    now: NOW,
    entryPoint: EP,
    gatorOf: () => GATOR,
    userOpSucceeded: (receipt) => receipt.inner === true,
    provider: {
      async getTransactionReceipt(hash) {
        const r = receipts[hash];
        if (!r) return null;
        return { status: r === 'outer-failed' ? 0 : 1, to: EP, inner: r === 'success', logs: [] };
      },
    },
    alertAdmins: async (text) => effects.alerts.push(text),
    markRequestPaid: async (...a) => effects.paid.push(a),
    releaseRequestProcessing: async (id) => effects.released.push(id),
    creditBack: async (row) => effects.credited.push(row.id),
    createClaim: async (p) => {
      const claim = { id: `claim-${fake.db.tables.claims.length + 1}`, hold_tx_hash: p.holdTxHash, amount_eth: p.amountEth };
      fake.db.tables.claims.push(claim);
      return { claim };
    },
    notifyAccount: async (id, text) => effects.notified.push([id, text]),
    notifyClaimRecipient: async (a) => effects.recipients.push(a.id),
    ...extra,
  };
}

function seed(tables = {}) {
  resetFlaggedCursors();
  receipts = {};
  effects = { alerts: [], paid: [], released: [], credited: [], notified: [], recipients: [] };
  fake = createFakeSupabase({ transfers: [], limit_orders: [], claim_hold_attempts: [], claims: [], ...tables });
}

const transfer = (over) => ({
  id: 't1',
  account_id: ACCOUNT,
  user_id: 'u1',
  status: 'submitted',
  tx_hash: H(1),
  kind: 'transfer',
  asset: 'ETH',
  amount_eth: '0.01',
  payment_request_id: null,
  created_at: ago(SETTLE_AFTER_MS + 1000),
  error: null,
  ...over,
});

beforeEach(() => seed());

describe('transfers', () => {
  it('a successful UserOp confirms the row and settles its payment request', async () => {
    seed({ transfers: [transfer({ payment_request_id: 'req-1' })] });
    receipts[H(1)] = 'success';
    const c = await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'confirmed');
    assert.deepEqual(effects.paid, [['req-1', ACCOUNT, H(1), '0.01']]);
    assert.equal(c.confirmed, 1);
  });

  it('an inner revert fails the row, releases the request, gives credit back', async () => {
    seed({ transfers: [transfer({ payment_request_id: 'req-1' })] });
    receipts[H(1)] = 'reverted';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    assert.deepEqual(effects.released, ['req-1']);
    assert.deepEqual(effects.credited, ['t1']);
    assert.deepEqual(effects.paid, []);
  });

  it('a failed outer transaction is a failure too', async () => {
    seed({ transfers: [transfer()] });
    receipts[H(1)] = 'outer-failed';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
  });

  it('too young: left for the send path', async () => {
    seed({ transfers: [transfer({ created_at: ago(1000) })] });
    receipts[H(1)] = 'success';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'submitted');
  });

  it('no receipt within the hour: untouched, no alert', async () => {
    seed({ transfers: [transfer()] });
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'submitted');
    assert.deepEqual(effects.alerts, []);
  });

  it('no receipt after an hour: still submitted, flagged once, admins told once', async () => {
    seed({ transfers: [transfer({ created_at: ago(UNKNOWN_AFTER_MS + 1000) })] });
    await runReconcileTick(deps());
    await runReconcileTick(deps());
    const row = fake.db.tables.transfers[0];
    assert.equal(row.status, 'submitted', 'never guessed');
    assert.equal(row.error, NO_RECEIPT_NOTE);
    assert.equal(effects.alerts.length, 1);
    assert.deepEqual(effects.released, []);
    assert.deepEqual(effects.credited, []);
  });

  it('compare-and-set: a row the send path already settled is left alone', async () => {
    seed({ transfers: [transfer({ status: 'confirmed' })] });
    receipts[H(1)] = 'reverted';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'confirmed');
    assert.deepEqual(effects.credited, []);
  });
});

describe('limit orders', () => {
  const order = (over) => ({
    id: 'o1',
    account_id: ACCOUNT,
    status: 'filling',
    tx_hash: H(2),
    updated_at: ago(SETTLE_AFTER_MS + 1000),
    error: null,
    ...over,
  });

  it('filled from a successful receipt', async () => {
    seed({ limit_orders: [order()] });
    receipts[H(2)] = 'success';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.limit_orders[0].status, 'filled');
    assert.ok(fake.db.tables.limit_orders[0].filled_at);
  });

  it('failed from a reverted receipt, never reopened', async () => {
    seed({ limit_orders: [order()] });
    receipts[H(2)] = 'reverted';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.limit_orders[0].status, 'failed');
  });

  it('no receipt after an hour: stays filling, admins told once', async () => {
    seed({ limit_orders: [order({ updated_at: ago(UNKNOWN_AFTER_MS + 1000) })] });
    await runReconcileTick(deps());
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.limit_orders[0].status, 'filling');
    assert.equal(effects.alerts.length, 1);
  });
});

describe('claim holds', () => {
  const attempt = (over) => ({
    id: 'a1',
    from_account_id: ACCOUNT,
    chain_id: 91342,
    status: 'submitted',
    amount_eth: '0.01',
    asset: 'ETH',
    token_address: null,
    nft_token_id: null,
    claim_args: { fromWaSender: '2348000000000', recipient: { kind: 'phone', phone: '2348099999999' } },
    hold_tx_hash: H(3),
    claim_id: null,
    created_at: ago(SETTLE_AFTER_MS + 1000),
    ...over,
  });

  it('landed with no claim: creates the claim from the intent, holds, tells both sides', async () => {
    seed({ claim_hold_attempts: [attempt()] });
    receipts[H(3)] = 'success';
    await runReconcileTick(deps());
    const a = fake.db.tables.claim_hold_attempts[0];
    assert.equal(fake.db.tables.claims.length, 1);
    assert.equal(fake.db.tables.claims[0].hold_tx_hash, H(3));
    assert.equal(a.status, 'held');
    assert.equal(a.claim_id, fake.db.tables.claims[0].id);
    assert.equal(effects.notified.length, 1);
    assert.deepEqual(effects.recipients, ['a1']);
  });

  it('a claim the send path already wrote is reused, never duplicated', async () => {
    seed({ claim_hold_attempts: [attempt()], claims: [{ id: 'c-existing', hold_tx_hash: H(3), amount_eth: '0.01' }] });
    receipts[H(3)] = 'success';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claims.length, 1);
    assert.equal(fake.db.tables.claim_hold_attempts[0].claim_id, 'c-existing');
    assert.deepEqual(effects.recipients, [], 'the send path already told them');
  });

  it('reverted: attempt failed, sender told nothing left the wallet, no claim', async () => {
    seed({ claim_hold_attempts: [attempt()] });
    receipts[H(3)] = 'reverted';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'failed');
    assert.equal(fake.db.tables.claims.length, 0);
    assert.match(effects.notified[0][1], /Nothing left your wallet/);
  });

  it('no receipt after an hour: unknown, admins told', async () => {
    seed({ claim_hold_attempts: [attempt({ created_at: ago(UNKNOWN_AFTER_MS + 1000) })] });
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'unknown');
    assert.equal(effects.alerts.length, 1);
    assert.equal(fake.db.tables.claims.length, 0);
  });

  it('a stale sending attempt was never broadcast: refused', async () => {
    seed({ claim_hold_attempts: [attempt({ status: 'sending', hold_tx_hash: null, created_at: ago(SENDING_STALE_MS + 1000) })] });
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'refused');
  });

  it('a fresh sending attempt is left alone', async () => {
    seed({ claim_hold_attempts: [attempt({ status: 'sending', hold_tx_hash: null, created_at: ago(1000) })] });
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'sending');
  });

  it('compare-and-set: an attempt already held is not touched', async () => {
    seed({ claim_hold_attempts: [attempt({ status: 'held', claim_id: 'c9' })] });
    receipts[H(3)] = 'success';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claims.length, 0);
    assert.equal(fake.db.tables.claim_hold_attempts[0].claim_id, 'c9');
  });
});

describe('wiring', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  it('runs in the WhatsApp process after the schema check, and not in Telegram', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(index, /await assertSchema\(\);[\s\S]{0,600}startReconciler\(\{ supabase, provider \}\);/);
    const telegram = fs.readFileSync(path.join(__dirname, '..', 'telegram.js'), 'utf8');
    assert.doesNotMatch(telegram, /startReconciler/);
  });

  it('admin alerts go through the sanctioned admin lookup', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reconcile.js'), 'utf8');
    assert.match(src, /adminAccountIds\(supabase\)/);
    assert.doesNotMatch(src.replace(/^\s*(\*|\/\/).*$/gm, ''), /is_admin/);
  });
});

describe('a receipt that turns up after the hour still settles', () => {
  const late = ago(UNKNOWN_AFTER_MS * 3);

  it('flagged transfer, then success: confirmed, flag cleared, request settled', async () => {
    seed({ transfers: [transfer({ created_at: late, error: NO_RECEIPT_NOTE, payment_request_id: 'req-9' })] });
    receipts[H(1)] = 'success';
    await runReconcileTick(deps());
    const row = fake.db.tables.transfers[0];
    assert.equal(row.status, 'confirmed');
    assert.equal(row.error, null);
    assert.deepEqual(effects.paid, [['req-9', ACCOUNT, H(1), '0.01']]);
  });

  it('flagged transfer, then a revert: failed, request released, credit back', async () => {
    seed({ transfers: [transfer({ created_at: late, error: NO_RECEIPT_NOTE, payment_request_id: 'req-9' })] });
    receipts[H(1)] = 'reverted';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    assert.deepEqual(effects.released, ['req-9']);
    assert.deepEqual(effects.credited, ['t1']);
  });

  it('flagged limit order, then success: filled', async () => {
    seed({
      limit_orders: [
        { id: 'o1', account_id: ACCOUNT, status: 'filling', tx_hash: H(2), updated_at: late, error: LIMIT_NO_RECEIPT_NOTE },
      ],
    });
    receipts[H(2)] = 'success';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.limit_orders[0].status, 'filled');
    assert.equal(fake.db.tables.limit_orders[0].error, null);
  });

  const unknownHold = () => ({
    id: 'a1',
    from_account_id: ACCOUNT,
    chain_id: 91342,
    status: 'unknown',
    amount_eth: '0.01',
    asset: 'ETH',
    token_address: null,
    nft_token_id: null,
    claim_args: { fromWaSender: '2348000000000', recipient: { kind: 'phone', phone: '2348099999999' } },
    hold_tx_hash: H(3),
    claim_id: null,
    created_at: late,
    error: NO_RECEIPT_NOTE,
  });

  it('unknown claim hold, then success: compare-and-set unknown to held, claim written, both told', async () => {
    seed({ claim_hold_attempts: [unknownHold()] });
    receipts[H(3)] = 'success';
    await runReconcileTick(deps());
    const a = fake.db.tables.claim_hold_attempts[0];
    assert.equal(a.status, 'held');
    assert.equal(a.error, null);
    assert.equal(fake.db.tables.claims.length, 1);
    assert.equal(a.claim_id, fake.db.tables.claims[0].id);
    assert.equal(effects.notified.length, 1);
    assert.deepEqual(effects.recipients, ['a1']);
  });

  it('unknown claim hold, then a revert: failed', async () => {
    seed({ claim_hold_attempts: [unknownHold()] });
    receipts[H(3)] = 'reverted';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'failed');
    assert.equal(fake.db.tables.claims.length, 0);
  });

  it('unknown claim hold, still no receipt: untouched, admins not told again', async () => {
    seed({ claim_hold_attempts: [unknownHold()] });
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'unknown');
    assert.deepEqual(effects.alerts, []);
  });
});

describe('flagged records never crowd out fresh ones, and each is rechecked in turn', () => {
  it('a fresh transfer settles in the first tick behind many flagged ones', async () => {
    const flagged = Array.from({ length: FLAGGED_BATCH * 6 }, (_, i) =>
      transfer({ id: `f${i}`, tx_hash: H(100 + i), created_at: ago(UNKNOWN_AFTER_MS * 5 - i * 1000), error: NO_RECEIPT_NOTE })
    );
    seed({ transfers: [...flagged, transfer({ id: 'fresh', tx_hash: H(99) })] });
    receipts[H(99)] = 'success';
    await runReconcileTick(deps());
    assert.equal(fake.db.tables.transfers.find((r) => r.id === 'fresh').status, 'confirmed');
  });

  it('over enough ticks every flagged transfer is read', async () => {
    const n = FLAGGED_BATCH * 3 + 4;
    const flagged = Array.from({ length: n }, (_, i) =>
      transfer({ id: `f${i}`, tx_hash: H(100 + i), created_at: ago(UNKNOWN_AFTER_MS * 5 - i * 1000), error: NO_RECEIPT_NOTE })
    );
    seed({ transfers: flagged });
    const asked = new Set();
    const d = deps();
    const inner = d.provider.getTransactionReceipt;
    d.provider.getTransactionReceipt = async (hash) => {
      asked.add(hash);
      return inner(hash);
    };
    for (let t = 0; t < Math.ceil(n / FLAGGED_BATCH); t += 1) await runReconcileTick(d);
    assert.equal(asked.size, n);
  });
});
