/**
 * A fee's life in the ledger (Phase 0d, part 3a): written as pending before
 * its payment is sent, then charged or waived exactly once.
 *
 * Covers: open, settle and waive, each moving a row only from pending, and
 * today's absorbed total leaving waived fees out; a chat send whose payment
 * lands (charged), reverts or is refused before sending (waived), or has no
 * answer (left pending); a send that waits for a passkey approval keeps its
 * fee pending, and after the approved payment the fee is collected through
 * the daily permission, or waived when it cannot be, and sent at most once
 * however many runs reach it (claimFee); an approval that is
 * cancelled waives the fee; and the reconciler settles a pending fee with the
 * payment it settles, collecting it for an approved one.
 *
 * Run: node --test test/feeLedgerStates.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const HASH = '0x' + 'ab'.repeat(32);
const FEE_HASH = '0x' + 'cd'.repeat(32);
const { GatorExecError } = require('../lib/gatorExecute');
const gatorExecute = require('../lib/gatorExecute');
let ownerAnswer;
gatorExecute.executeGatorCall = async (args) => {
  if (args.onBroadcast) await args.onBroadcast(HASH);
  return ownerAnswer(args);
};
gatorExecute.gatorGasReserveWei = async () => 0n;
const redeem = require('../lib/custody/redeem');
let permissionAnswer = null;
const permissionCalls = [];
redeem.trySendWithPermission = async (args) => {
  permissionCalls.push(args);
  return typeof permissionAnswer === 'function' ? permissionAnswer(args) : permissionAnswer;
};
const approvalsMod = require('../lib/custody/approvals');
approvalsMod.createApproval = async () => ({ id: 'ap-1', url: 'https://flizy.app/approve/AbCdEfGhIjKlMnOpQrStUv', expiresAt: new Date() });

const Q = require('../lib/feeQuote');
const SF = require('../lib/engine/sendFee');
const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { predictGatorAddress } = require('../lib/gatorAccount');
const { runReconcileTick } = require('../lib/reconcile');

const ACCOUNT = 'acct-ledger';
const USER = 'user-ledger';
const GATOR = predictGatorAddress(ACCOUNT);
const TO = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x' + '7e'.repeat(20);
const ON = { FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY };
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const quiet = { warn() {}, info() {}, error() {} };
const provider = {
  async getNetwork() {
    return { chainId: 91342n };
  },
  async getBalance() {
    return 10n ** 18n;
  },
  async getFeeData() {
    return { maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n };
  },
};

const savedEnv = { ...process.env };
function seed() {
  ownerAnswer = async () => ({ txHash: HASH, receipt: { status: 1, blockNumber: 9, logs: [] } });
  permissionAnswer = null;
  permissionCalls.length = 0;
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
    fee_ledger: [],
    account_reserves: [],
    custody_approvals: [],
  });
  Object.assign(process.env, ON);
}
beforeEach(seed);
process.on('exit', () => {
  for (const k of Object.keys(ON)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function feePlan() {
  const plan = {
    intent: 'SEND',
    expiresAt: Date.now() + 60_000,
    input: { amount: '0.01', asset: 'ETH', recipientLabel: 'john' },
    route: { kind: 'native_transfer', toAddress: TO, fromAddress: GATOR, chainName: 'GIWA Sepolia', chainId: 91342 },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
    estimated: {},
    policyChecks: {},
    createdAt: Date.now(),
  };
  const out = await SF.attachSendFee({ plan, supabase: fake.client, provider, chainKey: 'giwa_sepolia', accountId: ACCOUNT, ethBalanceWei: 10n ** 18n, gasBufferWei: 0n, env: ON, log: quiet });
  assert.equal(out.ok, true);
  return plan;
}
const send = (plan) => executeNativeSend({ plan, provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });
const rows = () => fake.db.tables.fee_ledger;

describe('the ledger helpers', () => {
  const quote = { kind: 'p2p', asset: 'ETH', feeUnits: '6666666666667', feeMicro: '20000', tierMicro: '20000', gasEstMicro: '9000', absorbMicro: '500', gasOverTier: false, priceMicro: '3000000000', priceSource: 'FEE_ETH_USD_RATE', pricedAt: new Date().toISOString() };
  const src = { sourceKind: 'transfer', sourceId: '22222222-2222-4222-8222-222222222222' };

  it('pending, then charged once; a charged fee is never waived', async () => {
    await Q.openFee({ supabase: fake.client, ...src, accountId: ACCOUNT, quote });
    assert.equal(rows()[0].state, 'pending');
    const pending = await Q.pendingFee({ supabase: fake.client, ...src });
    assert.deepEqual([pending.id, pending.asset, pending.fee_units, pending.account_id], [rows()[0].id, 'ETH', '6666666666667', ACCOUNT]);
    assert.equal(await Q.settleFee({ supabase: fake.client, ...src, txHash: HASH, gasPaid: 10n ** 12n, cfg: require('../lib/fees').feeConfig({}) }), true);
    assert.deepEqual([rows()[0].state, rows()[0].tx_hash, rows()[0].net_usd_micro], ['charged', HASH, '17000']);
    assert.equal(await Q.settleFee({ supabase: fake.client, ...src, txHash: HASH }), false);
    assert.equal(await Q.waiveFee({ supabase: fake.client, ...src, reason: 'late' }), false);
    assert.equal(rows()[0].state, 'charged');
  });

  it('a waived fee leaves today\'s absorbed total', async () => {
    await Q.openFee({ supabase: fake.client, ...src, quote });
    // The table stamps created_at; the fake does not.
    rows()[0].created_at = new Date().toISOString();
    assert.equal(await Q.absorbedTodayMicro(fake.client), 500n);
    assert.equal(await Q.waiveFee({ supabase: fake.client, ...src, reason: 'not sent' }), true);
    assert.deepEqual([rows()[0].state, rows()[0].waive_reason], ['waived', 'not sent']);
    assert.equal(await Q.absorbedTodayMicro(fake.client), 0n);
  });
});

describe('a chat send', () => {
  it('lands: the pending fee is charged with the payment\'s hash', async () => {
    const plan = await feePlan();
    const out = await send(plan);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(rows().length, 1);
    assert.deepEqual([rows()[0].state, rows()[0].tx_hash, rows()[0].source_id], ['charged', HASH, fake.db.tables.transfers[0].id]);
  });

  it('reverts: waived', async () => {
    ownerAnswer = async () => ({ txHash: HASH, receipt: { status: 0, blockNumber: 9, logs: [] } });
    await send(await feePlan());
    assert.deepEqual([rows()[0].state, rows()[0].waive_reason], ['waived', 'reverted']);
  });

  it('refused before anything was sent: waived', async () => {
    ownerAnswer = async () => {
      throw new GatorExecError('BROADCAST_REJECTED', 'refused');
    };
    const out = await send(await feePlan());
    assert.equal(out.submitted, false);
    assert.deepEqual([rows()[0].state, rows()[0].waive_reason], ['waived', 'not sent']);
  });

  it('no answer: left pending for the reconciler', async () => {
    ownerAnswer = async () => {
      throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet', { submitted: true, txHash: HASH });
    };
    const out = await send(await feePlan());
    assert.equal(out.submitted, true);
    assert.equal(rows()[0].state, 'pending');
  });

  it('over the passkey limit and waiting for approval: pending; refused instead: waived', async () => {
    permissionAnswer = { route: 'over_cap', available: 10n ** 15n, delegate: '0x' + 'bb'.repeat(20) };
    const waiting = await send(await feePlan());
    assert.equal(waiting.approvalPending, true);
    assert.equal(rows()[0].state, 'pending');

    seed();
    permissionAnswer = { route: 'over_cap', available: 10n ** 15n, delegate: '0x' + 'bb'.repeat(20), approvable: false };
    await send(await feePlan());
    assert.equal(rows()[0].state, 'waived');
  });
});

describe('after a passkey-approved payment', () => {
  async function waiting() {
    permissionAnswer = { route: 'over_cap', available: 10n ** 15n, delegate: '0x' + 'bb'.repeat(20) };
    await send(await feePlan());
    return fake.db.tables.transfers[0].id;
  }

  it('the fee is collected through the daily permission and charged with its own hash', async () => {
    const transferId = await waiting();
    permissionAnswer = async () => ({ route: 'permission', txHash: FEE_HASH, receipt: { gasUsed: 100n, gasPrice: 2n } });
    await SF.collectApprovedFee({ supabase: fake.client, provider, transferId, accountId: ACCOUNT, gator: GATOR, env: ON, log: quiet });
    const call = permissionCalls.at(-1);
    assert.deepEqual([call.symbol, call.to, call.amount], ['ETH', ethers.getAddress(TREASURY), BigInt(rows()[0].fee_units)]);
    assert.deepEqual([rows()[0].state, rows()[0].tx_hash, rows()[0].gas_paid_wei], ['charged', FEE_HASH, '200']);
  });

  it('waived when the daily permission cannot take it, or fees are off', async () => {
    const transferId = await waiting();
    permissionAnswer = { route: 'over_cap', available: 0n, delegate: '0x' + 'bb'.repeat(20) };
    await SF.collectApprovedFee({ supabase: fake.client, provider, transferId, accountId: ACCOUNT, gator: GATOR, env: ON, log: quiet });
    assert.deepEqual([rows()[0].state, rows()[0].waive_reason], ['waived', 'the daily permission refused it (over_cap)']);

    seed();
    const again = await waiting();
    await SF.collectApprovedFee({ supabase: fake.client, provider, transferId: again, accountId: ACCOUNT, gator: GATOR, env: {}, log: quiet });
    assert.deepEqual([rows()[0].state, rows()[0].waive_reason], ['waived', 'fees are off']);
  });

  it('two runs at once (the approval worker and the reconciler): the fee is sent once', async () => {
    const transferId = await waiting();
    const before = permissionCalls.length;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    // The first send waits, so the second run arrives while it is in flight.
    permissionAnswer = async () => {
      await held;
      return { route: 'permission', txHash: FEE_HASH, receipt: { gasUsed: 100n, gasPrice: 2n } };
    };
    const args = { supabase: fake.client, provider, transferId, accountId: ACCOUNT, gator: GATOR, env: ON, log: quiet };
    const first = SF.collectApprovedFee(args);
    const second = SF.collectApprovedFee(args);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    assert.equal(permissionCalls.length - before, 1);
    assert.equal(rows()[0].state, 'charged');
  });

  it('sent with no answer: left pending and claimed, so a later run does not send it again', async () => {
    const transferId = await waiting();
    const before = permissionCalls.length;
    permissionAnswer = async () => {
      throw new Error('no answer from the node');
    };
    const args = { supabase: fake.client, provider, transferId, accountId: ACCOUNT, gator: GATOR, env: ON, log: quiet };
    await SF.collectApprovedFee(args);
    assert.equal(rows()[0].state, 'pending');
    assert.ok(rows()[0].collecting_at);
    permissionAnswer = async () => ({ route: 'permission', txHash: FEE_HASH, receipt: { gasUsed: 100n, gasPrice: 2n } });
    await SF.collectApprovedFee(args);
    assert.equal(permissionCalls.length - before, 1);
    assert.equal(rows()[0].state, 'pending');
  });

  it('a claim that cannot be written sends nothing and leaves the fee pending', async () => {
    const transferId = await waiting();
    const before = permissionCalls.length;
    permissionAnswer = async () => ({ route: 'permission', txHash: FEE_HASH, receipt: { gasUsed: 100n, gasPrice: 2n } });
    const realFrom = fake.client.from.bind(fake.client);
    const broken = {
      ...fake.client,
      from: (t) => {
        const q = realFrom(t);
        if (t === 'fee_ledger') {
          const realUpdate = q.update.bind(q);
          // Only the claim (an update of collecting_at) fails, as when the column is not there yet.
          q.update = (patch) => ('collecting_at' in patch ? { eq: () => broken.chain } : realUpdate(patch));
        }
        return q;
      },
      chain: null,
    };
    const fail = { data: null, error: { message: 'column "collecting_at" does not exist' } };
    broken.chain = { eq: () => broken.chain, is: () => broken.chain, select: async () => fail };
    await SF.collectApprovedFee({ supabase: broken, provider, transferId, accountId: ACCOUNT, gator: GATOR, env: ON, log: quiet });
    assert.equal(permissionCalls.length - before, 0);
    assert.equal(rows()[0].state, 'pending');
  });

  it('an approval cancelled before it was sent waives the fee', async () => {
    const transferId = await waiting();
    fake.db.tables.custody_approvals.push({ id: 'ap-1', account_id: ACCOUNT, transfer_id: transferId, status: 'pending' });
    assert.equal(await approvalsMod.cancelOpenApprovals({ supabase: fake.client, accountId: ACCOUNT }), 1);
    assert.equal(rows()[0].state, 'waived');
  });
});

describe('the reconciler', () => {
  const tick = (extra = {}) =>
    runReconcileTick({
      supabase: fake.client,
      provider: { getTransactionReceipt: async () => ({ status: 1, to: TO, logs: [] }) },
      now: Date.now() + 3600e3,
      alertAdmins: async () => {},
      notifyAccount: async () => {},
      ...extra,
    });

  it('a pending fee is charged with the payment it settles, or waived when it failed', async () => {
    ownerAnswer = async () => {
      throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet', { submitted: true, txHash: HASH });
    };
    await send(await feePlan());
    assert.equal(rows()[0].state, 'pending');
    await tick();
    assert.deepEqual([rows()[0].state, rows()[0].tx_hash], ['charged', HASH]);

    seed();
    ownerAnswer = async () => {
      throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet', { submitted: true, txHash: HASH });
    };
    await send(await feePlan());
    await tick({ provider: { getTransactionReceipt: async () => ({ status: 0, to: TO, logs: [] }) } });
    assert.deepEqual([rows()[0].state, rows()[0].waive_reason], ['waived', 'reverted']);
  });
});
