/**
 * The fee on Flizy Pay API payouts (Phase 0f, part 1): lib/api/payoutFee.js,
 * the allowance sender, the payout worker, the Developers page text and the
 * platform script.
 *
 * Covers: none with fees off or a platform set to none; the person-to-person
 * tiers by default and for an unknown mode, recorded as an api_payout fee; a
 * platform's bps, rounded up; never taken from the payout; settings or a
 * quote that cannot be read wait rather than send; the allowance counts the
 * payout and the fee together and redeems both at once; the worker puts the
 * fee on the plan (so every check counts it), on the payout record, and on
 * both payout kinds, holds the daily limit to the total, and clears it when
 * nothing went out; and the page and the script say and set the mode.
 *
 * Run: node --test test/payoutFee.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const engine = require('../lib/engine');
const redeem = require('../lib/custody/redeem');
const reserves = require('../lib/reserves');
const agentWallet = require('../lib/agentWallet');
const gatorExecute = require('../lib/gatorExecute');
const accountTxLock = require('../lib/accountTxLock');
const dailyLimits = require('../lib/dailyLimits');
const payCode = require('../lib/payCode');

const PLATFORM = 'plat-1';
const ACCOUNT = 'acct-platform';
const WALLET = '0x' + 'ab'.repeat(20);
const ALICE_WALLET = '0x' + 'a1'.repeat(20);
const HASH = '0x' + 'cd'.repeat(32);
const TREASURY = ethers.getAddress('0x' + '7e'.repeat(20));
const ON = { FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY };

const seen = { executor: [], claims: [], daily: [], plans: [] };
engine.evaluateSendPolicy = async () => ({ decision: 'ALLOW', checks: {} });
engine.evaluateClaimHoldPolicy = async () => ({ decision: 'ALLOW', checks: {} });
engine.buildSendPlan = (args) => ({ intent: 'SEND', input: { amount: args.intent.amountEth, asset: 'ETH' }, route: { kind: 'native_transfer', toAddress: args.intent.toAddress }, actor: args.intent.actor });
engine.buildClaimPlan = (args) => ({ intent: 'CLAIM_HOLD', input: { amount: args.intent.amountEth, asset: 'ETH' }, route: { kind: 'claim_hold' }, actor: args.intent.actor });
engine.assertPlanFunded = (plan) => {
  seen.plans.push(plan);
  return { ok: true };
};
let executorImpl;
engine.executeNativeSend = async (args) => {
  seen.executor.push(args);
  return executorImpl(args);
};
engine.executeClaimHold = async (args) => {
  seen.claims.push(args);
  // As the real hold does: through the allowance, whose hash moves the payout to submitted.
  await args.permission.send({ supabase: fake.client, provider, accountId: ACCOUNT, wallet: WALLET, symbol: 'ETH', amount: 1n, to: ALICE_WALLET, onBroadcast: async () => {} });
  return { ok: true, claim: { id: 'cl-1' }, claimUrl: 'https://flizy.app/claim/x', holdTxHash: HASH };
};
reserves.refusePlanSpend = async () => ({ ok: true });
agentWallet.ensureAgentWallet = async () => ({ agent_wallet_address: WALLET });
gatorExecute.planGasBufferEth = async () => '0.001';
accountTxLock.tryAccountTxLock = async () => ({ ok: true });
accountTxLock.releaseAccountTxLock = async () => {};
dailyLimits.checkDailySendLimitNow = async (id, amount) => {
  seen.daily.push(amount);
  return { ok: true };
};
payCode.resolveFlizyPayDestination = async (db, raw) => (raw === 'alice' ? { found: true, address: ALICE_WALLET, label: '@alice' } : { found: false });
const permissionCalls = { plan: [], send: [] };
redeem.planPermissionSend = async (args) => {
  permissionCalls.plan.push(args);
  return { route: 'permission', signed: {}, available: 10n ** 18n };
};
redeem.sendWithPermission = async (args) => {
  permissionCalls.send.push(args);
  await args.onBroadcast(HASH);
  return { txHash: HASH, receipt: { status: 1 } };
};

const W = require('../lib/api/payoutWorker');
const AS = require('../lib/api/allowanceSend');
const PF = require('../lib/api/payoutFee');
const fees = require('../lib/fees');
let PT;
before(async () => {
  PT = await import('../web/lib/payoutFeeText.ts');
});

const quiet = { warn() {}, info() {}, error() {} };
const provider = {
  getBalance: async () => 10n ** 18n,
  getFeeData: async () => ({ maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n }),
};
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', nativeSymbol: 'ETH' };
const env = { API_PAYOUTS_ENABLED: 'true', API_RELAYER_KEY: ethers.Wallet.createRandom().privateKey, ...ON };
const ETH_FEE = 6_666_666_666_667n;

describe('the payout fee', () => {
  const ask = (platform, over = {}) =>
    PF.payoutFee({ platform, asset: 'ETH', amountUnits: 10n ** 16n, supabase: createFakeSupabase({ fee_ledger: [] }).client, provider, chainKey: 'giwa_sepolia', env: ON, log: quiet, ...over });

  it('none with fees off, or for a platform set to none', async () => {
    assert.deepEqual(await ask({ payout_fee_mode: 'tier' }, { env: {} }), { ok: true, fee: null });
    assert.deepEqual(await ask({ payout_fee_mode: 'none' }), { ok: true, fee: null });
  });

  it('the person-to-person tiers by default, or for a mode it does not know, as an api_payout fee on top', async () => {
    for (const platform of [{ payout_fee_mode: 'tier' }, {}, { payout_fee_mode: 'other' }]) {
      const out = await ask(platform);
      assert.deepEqual([out.fee.kind, out.fee.feeUnits, out.fee.feeText, out.fee.feeFromAmount], ['api_payout', String(ETH_FEE), '$0.02', false]);
      assert.deepEqual([out.fee.sendUnits, out.fee.totalUnits, out.fee.treasury], [String(10n ** 16n), String(10n ** 16n + ETH_FEE), TREASURY]);
    }
  });

  it("a platform's bps of each payout, rounded up; none when it rounds to 0", async () => {
    const out = await ask({ payout_fee_mode: 'bps', fee_bps: 50 }, { asset: 'TUSD', amountUnits: 100_000_000n });
    assert.deepEqual([out.fee.kind, out.fee.feeUnits, out.fee.tierMicro, out.fee.totalHuman], ['api_payout', '500000', null, '100.5']);
    assert.equal((await ask({ payout_fee_mode: 'bps', fee_bps: 1 }, { asset: 'TUSD', amountUnits: 101n })).fee.feeUnits, '1');
    assert.deepEqual(await ask({ payout_fee_mode: 'bps', fee_bps: 1 }, { asset: 'TUSD', amountUnits: 0n }), { ok: true, fee: null });
  });

  it('settings or a quote that cannot be read: not worked out, so the payout waits', async () => {
    assert.deepEqual(await ask({ payout_fee_mode: 'tier' }, { env: { FEES_ENABLED: 'true' } }), { ok: false, reason: 'fee settings unreadable' });
    const noFeeData = { getFeeData: async () => { throw new Error('rpc down'); } };
    assert.deepEqual(await ask({ payout_fee_mode: 'tier' }, { provider: noFeeData }), { ok: false, reason: 'fee unavailable' });
  });
});

describe('the allowance carries the fee', () => {
  beforeEach(() => {
    permissionCalls.plan.length = 0;
    permissionCalls.send.length = 0;
  });

  it('counts the payout and the fee together against what is left, and redeems both at once', async () => {
    const sender = AS.apiAllowanceSender({ platformId: PLATFORM, relayer: ethers.Wallet.createRandom(), log: quiet });
    const fee = { to: TREASURY, amount: 5n };
    const out = await sender.send({ supabase: fake.client, provider, accountId: ACCOUNT, wallet: WALLET, symbol: 'ETH', amount: 100n, to: ALICE_WALLET, fee, onBroadcast: async () => {} });
    assert.equal(out.route, 'permission');
    assert.equal(permissionCalls.plan[0].amount, 105n);
    assert.deepEqual([permissionCalls.send[0].amount, permissionCalls.send[0].fee], [100n, fee]);
  });

  it('without a fee, the payout alone, as before', async () => {
    const sender = AS.apiAllowanceSender({ platformId: PLATFORM, relayer: ethers.Wallet.createRandom(), log: quiet });
    await sender.send({ supabase: fake.client, provider, accountId: ACCOUNT, wallet: WALLET, symbol: 'ETH', amount: 100n, to: ALICE_WALLET, onBroadcast: async () => {} });
    assert.equal(permissionCalls.plan[0].amount, 100n);
    assert.equal(permissionCalls.send[0].fee, undefined);
  });
});

describe('the worker', () => {
  const MOVES = { queued: ['submitted', 'failed'], submitted: ['confirmed', 'claim_pending', 'failed'] };
  function payout(over = {}) {
    return { id: 'po-1', platform_id: PLATFORM, key_id: 'key-1', kind: 'payout', state: 'queued', amount: String(10n ** 16n), asset: 'ETH', recipient_kind: 'username', recipient_ref: 'alice', reference: null, tx_hash: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over };
  }
  let worker;
  function setup(platformOver = {}, payoutOver = {}) {
    fake = createFakeSupabase({
      api_platforms: [{ id: PLATFORM, account_id: ACCOUNT, display_name: 'Acme', wallet_address: WALLET, enabled: true, fee_bps: 0, payout_fee_mode: 'tier', claim_expiry_default_days: 30, claim_expiry_max_days: 30, ...platformOver }],
      api_keys: [{ id: 'key-1', revoked_at: null, scopes: ['read', 'payout'] }],
      api_control: [{ id: true, payouts_enabled: true }],
      api_platform_limits: [{ platform_id: PLATFORM, symbol: 'ETH', max_payout: String(10n ** 17n), daily_max: String(10n ** 18n) }],
      accounts: [{ id: ACCOUNT, daily_send_limit_eth: null }, { id: 'acct-alice', agent_wallet_address: ALICE_WALLET }],
      api_transactions: [payout(payoutOver)],
      api_allowances: [],
      fee_ledger: [],
    });
    Object.assign(seen, { executor: [], claims: [], daily: [], plans: [] });
    executorImpl = async (args) => {
      const sent = await args.permission.send({ supabase: fake.client, provider, accountId: ACCOUNT, wallet: WALLET, symbol: 'ETH', amount: 1n, to: ALICE_WALLET, onBroadcast: async () => {} });
      return sent && sent.route === 'permission' ? { ok: true, submitted: true, txHash: sent.txHash, transferId: 'tr-1' } : { ok: false, submitted: false, reason: 'ALLOWANCE', transferId: 'tr-1' };
    };
    const client = {
      from: (t) => fake.client.from(t),
      async rpc(name, args) {
        const r = fake.db.tables.api_transactions.find((x) => x.id === args.p_transaction_id);
        if (!r || !(MOVES[r.state] || []).includes(args.p_to_state)) return { data: null, error: { message: 'bad move' } };
        r.state = args.p_to_state;
        return { data: 'evt', error: null };
      },
    };
    worker = W.makeWorker({ supabase: client, provider, chain, notifyAccount: async () => {}, requestPaymentNotice: async () => 'sent', env, log: quiet });
  }
  const row = () => fake.db.tables.api_transactions[0];

  it('a direct payout: the fee on the plan for every check, on the payout record, and the daily limit holds the total', async () => {
    setup();
    assert.equal(await worker.processPayout({ ...row() }), 'confirmed');
    const plan = seen.executor[0].plan;
    assert.deepEqual([plan.fee.kind, plan.fee.feeUnits], ['api_payout', String(ETH_FEE)]);
    assert.equal(seen.plans[0], plan, 'the funds check saw the fee');
    assert.equal(row().fee_amount, String(ETH_FEE));
    assert.deepEqual(seen.daily, [ethers.formatEther(10n ** 16n + ETH_FEE)]);
  });

  it('a claim payout: the fee goes to the hold', async () => {
    setup({}, { recipient_kind: 'phone', recipient_ref: '+2348012345678' });
    assert.equal(await worker.processPayout({ ...row() }), 'claim_pending');
    assert.deepEqual([seen.claims[0].fee.units, ethers.getAddress(seen.claims[0].fee.treasury)], [ETH_FEE, TREASURY]);
    assert.equal(row().fee_amount, String(ETH_FEE));
  });

  it('a platform set to none: no fee anywhere', async () => {
    setup({ payout_fee_mode: 'none' });
    assert.equal(await worker.processPayout({ ...row() }), 'confirmed');
    assert.equal(seen.executor[0].plan.fee, undefined);
    assert.equal(row().fee_amount, null);
  });

  it('nothing went out: the fee is cleared from the record', async () => {
    setup();
    executorImpl = async () => ({ ok: false, submitted: false, reason: 'other', transferId: 'tr-1' });
    assert.equal(await worker.processPayout({ ...row() }), 'failed');
    assert.equal(row().fee_amount, null);
  });

  it('a fee that cannot be worked out: handed back, nothing sent', async () => {
    setup();
    worker = W.makeWorker({ supabase: { from: (t) => fake.client.from(t), rpc: async () => ({ data: 'evt', error: null }) }, provider, chain, env: { ...env, FEE_TREASURY_ADDRESS: '' }, log: quiet });
    assert.equal(await worker.processPayout({ ...row() }), 'later');
    assert.equal(seen.executor.length, 0);
  });
});

describe('what the platform sees and how Flizy sets it', () => {
  it('the Developers page says what each payout costs, or that there is none', () => {
    const cfg = fees.feeConfig(ON);
    assert.ok(cfg);
    assert.equal(PT.payoutFeeText('tier', 0, ON), '$0.02 per payout up to $100.00, plus $0.01 per started $100.00, paid by you');
    assert.equal(PT.payoutFeeText('bps', 50, ON), '0.5% of each payout, paid by you');
    assert.equal(PT.payoutFeeText('bps', 100, ON), '1% of each payout, paid by you');
    assert.equal(PT.payoutFeeText('none', 0, ON), 'None');
    assert.equal(PT.payoutFeeText('tier', 0, {}), 'None while Flizy fees are off');
    assert.match(read('web/components/AccountDevelopers.tsx'), /<Row name="Payout fee" value=\{platform\.payoutFee\} \/>/);
  });

  it('only Flizy sets it: the platform script takes a mode, and bps only with its rate', () => {
    const script = read('scripts/api-platform.mjs');
    assert.match(script, /case 'payout-fee': \{/);
    assert.match(script, /if \(!\['tier', 'bps', 'none'\]\.includes\(mode\)\) throw new Error\('--mode is tier, bps or none'\);/);
    assert.match(script, /if \(mode === 'bps'\) patch\.fee_bps = intFlag\('--bps', 0, 1, 1000\);/);
    const sql = read('supabase/migrations/20261116150000_api_payout_fee.sql');
    assert.match(sql, /check \(payout_fee_mode in \('tier', 'bps', 'none'\) and \(payout_fee_mode <> 'bps' or fee_bps > 0\)\)/);
  });
});
