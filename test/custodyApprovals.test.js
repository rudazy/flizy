/**
 * Passkey approvals on the bot side (lib/custody/approvals.js).
 *
 * What is pinned: an approval stores only the hash of its one-time token and
 * expires ten minutes after it opens; cancel and expiry close open approvals
 * and fail their transfer, so nothing moves; the worker sends only approvals
 * the passkey signed, claims each before sending so a second pass never sends
 * it again, never sends a cancelled or expired one, and tells the account how
 * it ended. An unknown outcome stays submitted for the reconciler.
 *
 * Run: node --test test/custodyApprovals.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const A = require('../lib/custody/approvals');
const C = require('../lib/custody/delegations');
const R = require('../lib/custody/redeem');

const ACCOUNT = '0b8c3f2a-1111-4222-8333-444455556666';
const GATOR = ethers.getAddress('0x' + 'aa'.repeat(20));
const TO = ethers.getAddress('0x' + '33'.repeat(20));
const relayer = ethers.Wallet.createRandom();
const NOW = new Date('2026-10-25T10:00:00Z');

let fake;
let notices;
const db = () => fake.client;
const approvals = () => fake.db.tables.custody_approvals || [];
const notify = async (id, body) => notices.push([id, body]);
const explorerUrl = (h) => `https://explorer.test/tx/${h}`;
const quiet = { warn() {}, info() {} };

beforeEach(() => {
  fake = createFakeSupabase({ custody_approvals: [], transfers: [{ id: 'tx-row', status: 'pending', account_id: ACCOUNT }] });
  notices = [];
});

const open = (over = {}) =>
  A.createApproval({
    supabase: db(),
    accountId: ACCOUNT,
    gator: GATOR,
    delegate: relayer.address,
    symbol: 'ETH',
    to: TO,
    amount: 2n * 10n ** 17n,
    amountDisplay: '0.2 ETH',
    recipientLabel: 'john',
    transferId: 'tx-row',
    siteUrl: 'https://flizy.app/',
    now: NOW,
    ...over,
  });

/** Marks the stored approval signed with a real one-off permission (signature is a placeholder). */
function sign(row) {
  const { delegation } = C.buildOneOff({
    account: row.gator,
    delegate: row.delegate,
    symbol: row.symbol,
    to: row.to_address,
    amount: BigInt(row.amount),
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    salt: 9n,
  });
  Object.assign(row, { status: 'signed', salt: '9', caveats: delegation.caveats, digest: C.delegationDigest(delegation), signature: '0x1234' });
}

describe('opening an approval', () => {
  it('stores only the hash of a one-time token, and lasts ten minutes', async () => {
    const out = await open();
    const token = out.url.split('/approve/')[1];
    assert.match(out.url, /^https:\/\/flizy\.app\/approve\/[A-Za-z0-9_-]{22}$/);
    const row = approvals()[0];
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(row).includes(token), false, 'the raw token is never stored');
    assert.equal(new Date(row.expires_at).getTime() - NOW.getTime(), 10 * 60 * 1000);
    assert.deepEqual([row.status, row.amount, row.to_address, row.recipient_label], ['pending', String(2n * 10n ** 17n), TO, 'john']);
  });

  it('refuses a non-positive amount', async () => {
    await assert.rejects(() => open({ amount: 0n }), /positive bigint/);
  });
});

describe('cancel and expiry move nothing', () => {
  it('cancel closes open approvals and fails their transfer', async () => {
    await open();
    assert.equal(await A.cancelOpenApprovals({ supabase: db(), accountId: ACCOUNT, now: NOW }), 1);
    assert.equal(approvals()[0].status, 'cancelled');
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    assert.equal(await A.cancelOpenApprovals({ supabase: db(), accountId: ACCOUNT, now: NOW }), 0, 'nothing left to cancel');
  });

  it('expiry closes late approvals, fails the transfer, and tells the account', async () => {
    await open();
    const later = new Date(NOW.getTime() + 10 * 60 * 1000 + 1);
    assert.equal(await A.expireApprovals({ supabase: db(), notify, now: later }), 1);
    assert.equal(approvals()[0].status, 'expired');
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    assert.match(notices[0][1], /was not approved in time, so it was not sent/);
  });

  it('a cancelled or expired approval is never sent, even if it had been signed', async () => {
    await open();
    sign(approvals()[0]);
    await A.cancelOpenApprovals({ supabase: db(), accountId: ACCOUNT, now: NOW });
    let calls = 0;
    const p = { estimateGas: async () => { calls += 1; return 1n; } };
    assert.equal(await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer, now: NOW, log: quiet }), 0);
    assert.equal(calls, 0);
  });
});

describe('the worker sends what the passkey signed', () => {
  /** Stands in for sendWithPermission's provider: one send, receipt success. */
  function chain({ fail = null } = {}) {
    const calls = [];
    return {
      calls,
      estimateGas: async () => {
        calls.push('estimate');
        if (fail === 'refuse') throw Object.assign(new Error('allowance-exceeded'), { shortMessage: 'allowance-exceeded' });
        return 100000n;
      },
      getFeeData: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }),
      getBalance: async () => 10n ** 18n,
      getTransactionCount: async () => 0,
      getNetwork: async () => ({ chainId: 91342n }),
      broadcastTransaction: async () => calls.push('broadcast'),
      waitForTransaction: async () => {
        calls.push('wait');
        if (fail === 'unknown') return null;
        return { status: 1 };
      },
    };
  }
  const wallet = (p) => relayer.connect(p);

  it('claims, sends once, records the hash, confirms the transfer, and tells the account', async () => {
    await open();
    sign(approvals()[0]);
    const p = chain();
    assert.equal(await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet }), 1);
    const row = approvals()[0];
    assert.equal(row.status, 'sent');
    assert.match(row.tx_hash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual([fake.db.tables.transfers[0].status, fake.db.tables.transfers[0].tx_hash], ['confirmed', row.tx_hash]);
    assert.match(notices[0][1], /^Approved and sent: 0\.2 ETH to john\.\nhttps:\/\/explorer\.test\/tx\/0x/);
    assert.equal(await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet }), 0);
    assert.equal(p.calls.filter((c) => c === 'broadcast').length, 1, 'never sent twice');
  });

  it('two workers at once: only one claims the approval', async () => {
    await open();
    sign(approvals()[0]);
    const p = chain();
    const results = await Promise.all([1, 2].map(() => A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet })));
    assert.equal(results[0] + results[1], 1);
    assert.equal(p.calls.filter((c) => c === 'broadcast').length, 1);
  });

  it('waits, sending nothing, while the relayer key is unset', async () => {
    await open();
    sign(approvals()[0]);
    assert.equal(await A.sendSignedApprovals({ supabase: db(), provider: chain(), notify, explorerUrl, relayer: null, now: NOW, log: quiet }), 0);
    assert.equal(approvals()[0].status, 'signed');
  });

  it('a send the chain would refuse fails the approval, moves nothing, and says so', async () => {
    await open();
    sign(approvals()[0]);
    const p = chain({ fail: 'refuse' });
    await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet });
    assert.equal(approvals()[0].status, 'failed');
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    assert.equal(p.calls.includes('broadcast'), false);
    assert.match(notices[0][1], /could not be sent\. Nothing moved\./);
  });

  it('an unknown outcome stays submitted with its hash, for the reconciler', async () => {
    await open();
    sign(approvals()[0]);
    const p = chain({ fail: 'unknown' });
    await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet });
    assert.equal(approvals()[0].status, 'submitted');
    assert.equal(fake.db.tables.transfers[0].status, 'submitted');
    assert.deepEqual(notices, []);
  });

  it('refuses an approval that names another relayer, or whose permission does not match its digest', async () => {
    await open({ delegate: ethers.Wallet.createRandom().address });
    sign(approvals()[0]);
    const p = chain();
    await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet });
    assert.equal(approvals()[0].status, 'failed');
    fake = createFakeSupabase({ custody_approvals: [], transfers: [] });
    await open({ transferId: null });
    sign(approvals()[0]);
    approvals()[0].salt = '10';
    await A.sendSignedApprovals({ supabase: db(), provider: p, notify, explorerUrl, relayer: wallet(p), now: NOW, log: quiet });
    assert.equal(approvals()[0].status, 'failed');
    assert.equal(p.calls.includes('broadcast'), false);
  });

  it('the one-off permission it redeems is the shape the worker rebuilds', () => {
    // signedFromRow is how the worker reads a stored approval.
    const row = { symbol: 'ETH', gator: GATOR, delegate: relayer.address, to_address: TO, amount: '5', expires_at: NOW.toISOString() };
    sign(row);
    const signed = R.signedFromRow(row);
    assert.equal(signed.delegation.caveats[0].enforcer, C.CONTRACTS.nativeTokenTransferAmountEnforcer);
    assert.throws(() => R.signedFromRow({ ...row, digest: '0x' + '00'.repeat(32) }), R.PermissionNotUsed);
  });
});
