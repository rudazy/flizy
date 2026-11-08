/**
 * The Flizy Pay API worker's claim flows (lib/api/payoutWorker.js), phase 2b.
 *
 * What is pinned: a phone, email or numeric platform id is always paid as a
 * claim through the allowance (never the owner key), with an expiry within the
 * platform's maximum, the claim link stored, and a member told by the name
 * Flizy assigned; an unknown hold is settled from its receipt once its claim
 * exists; then claimed -> confirmed, cancelled in chat -> refunded, expired or
 * cancelled by the platform -> the claim locked first and refunded only on a
 * confirmed refund; a recipient who took the lock first keeps the claim; an
 * unknown refund is settled from its receipt; and every state counts against
 * the rolling day except failed.
 *
 * The engine's executors are recorders; the database is the in-memory fake.
 *
 * Run: node --test test/apiClaimWorker.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const engine = require('../lib/engine');
const reserves = require('../lib/reserves');
const agentWallet = require('../lib/agentWallet');
const gatorExecute = require('../lib/gatorExecute');
const accountTxLock = require('../lib/accountTxLock');
const dailyLimits = require('../lib/dailyLimits');
const identity = require('../lib/identity');
const accountEmails = require('../lib/accountEmails');
const redeem = require('../lib/custody/redeem');

const PLATFORM = 'plat-1';
const ACCOUNT = 'acct-platform';
const WALLET = '0x' + 'ab'.repeat(20);
const HOLD = '0x' + 'cd'.repeat(32);
const REFUND = '0x' + 'ef'.repeat(32);

const seen = { holds: [], refunds: [], policy: [] };
let holdImpl;
let refundImpl;
engine.evaluateClaimHoldPolicy = async (intent, opts) => {
  seen.policy.push({ intent, opts });
  return { decision: 'ALLOW_WITH_CONFIRM', checks: {} };
};
engine.buildClaimPlan = (args) => ({ intent: 'CLAIM_HOLD', input: { amount: args.intent.amountEth }, route: { recipient: args.recipient }, actor: args.intent.actor });
engine.assertPlanFunded = () => ({ ok: true });
engine.executeClaimHold = async (args) => {
  seen.holds.push(args);
  return holdImpl(args);
};
engine.executeClaimRefund = async (args) => {
  seen.refunds.push(args);
  return refundImpl(args);
};
reserves.refusePlanSpend = async () => ({ ok: true });
agentWallet.ensureAgentWallet = async () => ({ agent_wallet_address: WALLET });
gatorExecute.planGasBufferEth = async () => '0.001';
accountTxLock.tryAccountTxLock = async () => ({ ok: true });
accountTxLock.releaseAccountTxLock = async () => {};
dailyLimits.checkDailySendLimitNow = async () => ({ ok: true });
let member = null;
identity.findAccountIdByPhone = async () => member;
identity.getAccountByIdentity = async () => (member ? { account: { id: member } } : null);
accountEmails.findAccountIdByEmail = async () => member;

// The allowance sender runs for real over these: it stores the hold's hash
// (queued -> submitted) before the "broadcast", as on chain.
redeem.planPermissionSend = async () => ({ route: 'permission', signed: {}, available: 10n ** 18n });
redeem.sendWithPermission = async (args) => {
  await args.onBroadcast(HOLD);
  return { txHash: HOLD, receipt: { status: 1 } };
};

const W = require('../lib/api/payoutWorker');

const MOVES = {
  accepted: ['queued', 'submitted', 'expired', 'failed'],
  queued: ['submitted', 'failed'],
  submitted: ['confirmed', 'claim_pending', 'failed'],
  claim_pending: ['confirmed', 'expired', 'refund_pending'],
  expired: ['refund_pending'],
  refund_pending: ['refunded'],
};
let events;
const client = {
  from: (t) => fake.client.from(t),
  async rpc(name, args) {
    if (name !== 'api_transition') return fake.client.rpc(name, args);
    const row = fake.db.tables.api_transactions.find((r) => r.id === args.p_transaction_id);
    if (!row || !(MOVES[row.state] || []).includes(args.p_to_state)) {
      return { data: null, error: { message: `api transition ${row && row.state} -> ${args.p_to_state} is not allowed` } };
    }
    events.push(`${row.state}->${args.p_to_state}`);
    row.state = args.p_to_state;
    return { data: 'evt', error: null };
  },
};

const notices = [];
let receipt;
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const provider = {
  getBalance: async () => 10n ** 18n,
  getTransactionReceipt: async () => receipt,
  call: async () => ERC20.encodeFunctionResult('balanceOf', [10n ** 12n]),
};
/** What executeClaimHold does with the allowance: the hash stored, then the hold. */
const holdThrough = async (args) =>
  args.permission.send({ supabase: client, provider, accountId: ACCOUNT, wallet: WALLET, symbol: 'TUSD', amount: 1n, to: '0x' + 'e5'.repeat(20), onBroadcast: async () => {} });
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', nativeSymbol: 'ETH' };
const quiet = { warn() {}, info() {}, error() {} };
const old = () => new Date(Date.now() - 3 * 60 * 1000).toISOString();

function payout(over = {}) {
  return {
    id: 'po-1',
    platform_id: PLATFORM,
    key_id: 'key-1',
    kind: 'payout',
    state: 'queued',
    amount: String(5n * 10n ** 6n),
    asset: 'TUSD',
    recipient_kind: 'phone',
    recipient_ref: '+2348000000001',
    reference: null,
    tx_hash: null,
    claim_id: null,
    claim_expiry_days: null,
    cancel_requested_at: null,
    refund_tx_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}
const claimRow = (over = {}) => ({
  id: 'cl-1',
  from_account_id: ACCOUNT,
  status: 'pending',
  claim_token: 'tok',
  hold_tx_hash: HOLD,
  api_transaction_id: 'po-1',
  expires_at: new Date(Date.now() + 86400e3).toISOString(),
  ...over,
});

let worker;
beforeEach(() => {
  fake = createFakeSupabase({
    api_platforms: [
      { id: PLATFORM, account_id: ACCOUNT, display_name: 'Acme', wallet_address: WALLET, enabled: true, claim_expiry_default_days: 30, claim_expiry_max_days: 45 },
    ],
    api_keys: [{ id: 'key-1', revoked_at: null, scopes: ['read', 'payout'] }],
    api_control: [{ id: true, payouts_enabled: true }],
    api_platform_limits: [{ platform_id: PLATFORM, symbol: 'TUSD', max_payout: String(50n * 10n ** 6n), daily_max: String(100n * 10n ** 6n) }],
    accounts: [{ id: ACCOUNT, daily_send_limit_eth: null }],
    api_transactions: [payout()],
    claims: [],
  });
  events = [];
  notices.length = 0;
  Object.assign(seen, { holds: [], refunds: [], policy: [] });
  member = null;
  receipt = null;
  holdImpl = async (args) => {
    await holdThrough(args);
    return { ok: true, claim: { id: 'cl-1' }, claimUrl: 'https://flizy.app/claim/tok', holdTxHash: HOLD };
  };
  refundImpl = async (args) => {
    await args.onBroadcast(REFUND);
    return { ok: true, refundTxHash: REFUND };
  };
  worker = W.makeWorker({
    supabase: client,
    provider,
    chain,
    notifyAccount: async (id, body) => notices.push([id, body]),
    requestPaymentNotice: async () => 'sent',
    env: { API_PAYOUTS_ENABLED: 'true', API_RELAYER_KEY: ethers.Wallet.createRandom().privateKey },
    log: quiet,
  });
});
const row = () => fake.db.tables.api_transactions[0];

describe('an identity payout becomes a claim', () => {
  it('holds through the allowance, stores the link and expiry, and tells a member by the partner name', async () => {
    member = 'acct-member';
    assert.equal(await worker.processPayout({ ...row() }), 'claim_pending');
    const h = seen.holds[0];
    assert.equal(h.permission.ownerKey, false, 'allowance only');
    assert.deepEqual(h.recipient, { kind: 'phone', phone: '2348000000001' }, 'the claims table form of the number');
    assert.equal(h.apiTransactionId, 'po-1');
    const days = (Date.parse(h.expiresAt) - Date.now()) / 86400e3;
    assert.ok(days > 29.9 && days <= 30, 'platform default of 30 days');
    assert.deepEqual(events, ['queued->submitted', 'submitted->claim_pending']);
    assert.equal(row().tx_hash, HOLD, 'the hold hash, stored before it was sent');
    assert.deepEqual([row().claim_id, row().claim_url, row().claim_expires_at], ['cl-1', 'https://flizy.app/claim/tok', h.expiresAt]);
    assert.equal(seen.policy[0].opts.apiPayout, true);
    assert.equal(seen.policy[0].intent.toAddress, null, 'no address for a claim');
    assert.match(notices[0][1], /^Pending claim on Flizy\n\nAmount: 5 tUSD\nFrom:   Acme \(Flizy partner\)/);
  });

  it('nobody is told when the recipient is not on Flizy, and the payout looks the same', async () => {
    assert.equal(await worker.processPayout({ ...row() }), 'claim_pending');
    assert.equal(notices.length, 0);
  });

  it('keeps a requested expiry, but never past the platform maximum', async () => {
    row().claim_expiry_days = 90;
    await worker.processPayout({ ...row() });
    const days = (Date.parse(seen.holds[0].expiresAt) - Date.now()) / 86400e3;
    assert.ok(days > 44.9 && days <= 45);
  });

  it('a platform id must be numeric', async () => {
    Object.assign(row(), { recipient_kind: 'telegram', recipient_ref: '@ada' });
    assert.equal(await worker.processPayout({ ...row() }), 'failed');
    assert.equal(row().error_code, 'invalid_recipient');
    assert.equal(seen.holds.length, 0);
  });

  it('a refused hold fails with the allowance reason and no hash', async () => {
    holdImpl = async () => ({ ok: false, submitted: false, reason: 'ALLOWANCE' });
    assert.equal(await worker.processPayout({ ...row() }), 'failed');
    assert.equal(row().tx_hash, null);
  });

  it('an unknown hold waits, then is settled from its receipt once its claim exists', async () => {
    holdImpl = async (args) => {
      await holdThrough(args);
      return { ok: false, submitted: true };
    };
    assert.equal(await worker.processPayout({ ...row() }), 'submitted');
    assert.deepEqual([row().state, row().tx_hash], ['submitted', HOLD]);
    row().updated_at = old();
    receipt = { status: 1 };
    await worker.reconcile();
    assert.equal(row().state, 'submitted', 'the claim is not written yet: wait');
    fake.db.tables.claims.push(claimRow());
    await worker.reconcile();
    assert.equal(row().state, 'claim_pending');
    assert.equal(row().claim_url.endsWith('/claim/tok'), true);
  });

  it('every state that may have moved money counts against the day; failed does not', async () => {
    for (const [i, state] of ['claim_pending', 'refunded', 'refund_pending', 'failed'].entries()) {
      fake.db.tables.api_transactions.push(payout({ id: `po-${i + 10}`, state, amount: String(32n * 10n ** 6n) }));
    }
    assert.equal(await worker.processPayout({ ...row() }), 'failed');
    assert.equal(row().error_code, 'over_daily_max', '3 x 32 counted (the failed one is not) + 5 = 101 > 100');
  });
});

describe('after the hold', () => {
  beforeEach(() => {
    // Last looked at long enough ago to be looked at again.
    Object.assign(row(), { state: 'claim_pending', claim_id: 'cl-1', tx_hash: HOLD, updated_at: old() });
  });

  it('claimed by the recipient: confirmed', async () => {
    fake.db.tables.claims.push(claimRow({ status: 'claimed', claim_tx_hash: '0x' + '11'.repeat(32) }));
    await worker.watchClaims();
    assert.deepEqual(events, ['claim_pending->confirmed']);
  });

  it('cancelled by the platform owner in chat: recorded as refunded, nothing sent again', async () => {
    fake.db.tables.claims.push(claimRow({ status: 'cancelled', refund_tx_hash: REFUND }));
    await worker.watchClaims();
    assert.deepEqual(events, ['claim_pending->refund_pending', 'refund_pending->refunded']);
    assert.equal(seen.refunds.length, 0);
    assert.equal(row().refund_tx_hash, REFUND);
  });

  it('still claimable and not cancelled: left alone', async () => {
    fake.db.tables.claims.push(claimRow());
    await worker.watchClaims();
    assert.deepEqual(events, []);
  });

  it('past its expiry: locked, expired, refunded from escrow with the hash stored first', async () => {
    fake.db.tables.claims.push(claimRow({ expires_at: new Date(Date.now() - 1000).toISOString() }));
    await worker.watchClaims();
    assert.deepEqual(events, ['claim_pending->expired', 'expired->refund_pending', 'refund_pending->refunded']);
    assert.equal(fake.db.tables.claims[0].status, 'processing', 'locked before the payout said refunding');
    assert.equal(seen.refunds[0].held, true);
    assert.equal(seen.refunds[0].fromAccountId, ACCOUNT);
    assert.equal(row().refund_tx_hash, REFUND);
  });

  it('cancelled by the platform: locked, then refunded', async () => {
    row().cancel_requested_at = new Date().toISOString();
    fake.db.tables.claims.push(claimRow());
    await worker.watchClaims();
    assert.deepEqual(events, ['claim_pending->refund_pending', 'refund_pending->refunded']);
  });

  it('the recipient got the lock first: the claim is theirs, no refund', async () => {
    row().cancel_requested_at = new Date().toISOString();
    fake.db.tables.claims.push(claimRow({ status: 'processing' }));
    await worker.watchClaims();
    assert.deepEqual(events, []);
    assert.equal(seen.refunds.length, 0);
  });

  it('a refund not done yet stays refund_pending, locked, and is tried again', async () => {
    row().cancel_requested_at = new Date().toISOString();
    fake.db.tables.claims.push(claimRow());
    refundImpl = async () => ({ ok: false, error: 'Escrow cannot refund right now (insufficient gas). Try later.' });
    await worker.watchClaims();
    assert.equal(row().state, 'refund_pending');
    assert.equal(fake.db.tables.claims[0].status, 'processing');
    refundImpl = async (args) => {
      await args.onBroadcast(REFUND);
      return { ok: true, outcome: 'moved', refundTxHash: REFUND };
    };
    row().updated_at = old();
    await worker.watchClaims();
    assert.equal(row().state, 'refunded');
  });

  it('a refund the node refused after its hash was stored: the hash is cleared, and it is sent again', async () => {
    row().cancel_requested_at = new Date().toISOString();
    fake.db.tables.claims.push(claimRow());
    refundImpl = async (args) => {
      await args.onBroadcast(REFUND);
      return { ok: false, outcome: 'not_sent', error: 'Refund failed. Try again shortly.' };
    };
    await worker.watchClaims();
    assert.deepEqual([row().state, row().refund_tx_hash], ['refund_pending', null]);
  });

  it('a refund whose money moved but whose claim update failed keeps its hash: never sent twice', async () => {
    row().cancel_requested_at = new Date().toISOString();
    fake.db.tables.claims.push(claimRow());
    refundImpl = async (args) => {
      await args.onBroadcast(REFUND);
      return { ok: false, outcome: 'moved', refundTxHash: REFUND, error: 'Refund sent but claim status update failed.' };
    };
    await worker.watchClaims();
    assert.equal(row().refund_tx_hash, REFUND);
    Object.assign(row(), { updated_at: old() });
    receipt = { status: 1 };
    await worker.watchClaims();
    assert.equal(row().state, 'refunded');
    assert.equal(seen.refunds.length, 1, 'the receipt settled it; no second refund');
  });

  it('more than one pass of claims: every claim gets its turn', async () => {
    fake.db.tables.claims.push(claimRow());
    await worker.watchClaims();
    assert.ok(Date.now() - Date.parse(row().updated_at) < 5000, 'a waiting claim is marked as looked at');
    await worker.watchClaims();
    assert.deepEqual(events, [], 'and not looked at again straight away');
  });

  it('a refund with an unknown outcome is settled from its receipt: confirmed cancels the claim', async () => {
    Object.assign(row(), { state: 'refund_pending', refund_tx_hash: REFUND, updated_at: old() });
    fake.db.tables.claims.push(claimRow({ status: 'processing' }));
    receipt = null;
    await worker.watchClaims();
    assert.equal(row().state, 'refund_pending');
    receipt = { status: 1 };
    await worker.watchClaims();
    assert.equal(row().state, 'refunded');
    assert.equal(fake.db.tables.claims[0].status, 'cancelled');
    assert.equal(seen.refunds.length, 0, 'never sent twice');
  });

  it('a refund that reverted is cleared and sent again, the claim still locked', async () => {
    Object.assign(row(), { state: 'refund_pending', refund_tx_hash: REFUND, updated_at: old() });
    fake.db.tables.claims.push(claimRow({ status: 'processing' }));
    receipt = { status: 0 };
    await worker.watchClaims();
    assert.equal(row().refund_tx_hash, null);
    assert.equal(fake.db.tables.claims[0].status, 'processing');
    row().updated_at = old();
    await worker.watchClaims();
    assert.equal(row().state, 'refunded');
  });
});
