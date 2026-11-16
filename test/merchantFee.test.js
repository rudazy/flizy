/**
 * The merchant fee on a chat payment to a business (Phase 0e, part 3a):
 * lib/feeQuote.js quoteMerchantFee, lib/engine/sendFee.js, the executors,
 * the passkey approval path, the reconciler and the business's notices.
 *
 * Covers: 1% of the price, rounded up, none when it rounds to 0; a send to a
 * business carries it instead of the person-to-person fee, and paying your own
 * business does not; the payer's amount, checks, preview and receipt stay the
 * price with no fee; the business is paid the price less the fee and the fee
 * goes to the treasury in the same operation (wallet and permission paths);
 * over the passkey limit, the approval covers the business's part and the fee
 * is then collected; the ledger row is the merchant kind, charged or settled by
 * the reconciler; and the business is told what arrived and what Flizy kept.
 *
 * Run: node --test test/merchantFee.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const HASH = '0x' + 'ab'.repeat(32);
const FEE_HASH = '0x' + 'cd'.repeat(32);
const gatorExecute = require('../lib/gatorExecute');
const ownerCalls = [];
gatorExecute.executeGatorCall = async (args) => {
  ownerCalls.push(args);
  if (args.onBroadcast) await args.onBroadcast(HASH);
  return { txHash: HASH, receipt: { status: 1, blockNumber: 9, logs: [] } };
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
const approvalAsks = [];
approvalsMod.createApproval = async (args) => {
  approvalAsks.push(args);
  return { id: 'ap-1', url: 'https://flizy.app/approve/AbCdEfGhIjKlMnOpQrStUv', expiresAt: new Date() };
};

const Q = require('../lib/feeQuote');
const SF = require('../lib/engine/sendFee');
const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { formatPlanPreview, assertPlanFunded } = require('../lib/engine/plan');
const { formatSendReceipt } = require('../lib/engine/receipt');
const { refusePlanSpend } = require('../lib/reserves');
const { formatReceivedNotice } = require('../lib/notify');
const { formatRequestPaidNotice } = require('../lib/paymentRequests');
const { formatPotContributionNotice } = require('../lib/pots');
const { predictGatorAddress } = require('../lib/gatorAccount');
const { runReconcileTick } = require('../lib/reconcile');
const fees = require('../lib/fees');

const ACCOUNT = 'acct-payer';
const BUSINESS = 'acct-biz';
const USER = 'user-payer';
const GATOR = predictGatorAddress(ACCOUNT);
const SHOP = ethers.getAddress('0x' + '5b'.repeat(20));
const TREASURY = ethers.getAddress('0x' + '7e'.repeat(20));
const TUSD = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
const ON = { FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY };
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const quiet = { warn() {}, info() {}, error() {} };
const ERC20 = new ethers.Interface([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
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
  async call({ data }) {
    const fn = ERC20.parseTransaction({ data });
    if (fn.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [6]);
    return ERC20.encodeFunctionResult('balanceOf', [10n ** 12n]);
  },
};

/** 1% of 0.05 ETH. */
const FEE = 5n * 10n ** 14n;
const PRICE = 5n * 10n ** 16n;

const savedEnv = { ...process.env };
function seed(over = {}) {
  ownerCalls.length = 0;
  permissionCalls.length = 0;
  approvalAsks.length = 0;
  permissionAnswer = null;
  fake = createFakeSupabase({
    accounts: [
      { id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 },
      { id: BUSINESS, agent_wallet_address: SHOP, is_business: true, business_terms_version: '2026-11-16', business_since: new Date().toISOString() },
    ],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
    fee_ledger: [],
    account_reserves: [],
    custody_approvals: [],
    claim_hold_attempts: [],
    claims: [],
    limit_orders: [],
    ...over,
  });
  Object.assign(process.env, ON);
}
beforeEach(() => seed());
process.on('exit', () => {
  for (const k of Object.keys(ON)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function plan(over = {}) {
  const token = over.asset === 'TUSD';
  return {
    intent: 'SEND',
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    input: { amount: over.amount || (token ? '10' : '0.05'), asset: over.asset || 'ETH', recipientLabel: '@shop', tokenAddress: token ? TUSD : null },
    route: { kind: token ? 'erc20_transfer' : 'native_transfer', toAddress: over.to || SHOP, fromAddress: GATOR, tokenAddress: token ? TUSD : null, chainName: 'GIWA Sepolia', chainId: 91342 },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
    estimated: {},
    policyChecks: {},
  };
}
const attach = (p, extra = {}) =>
  SF.attachSendFee({ plan: p, supabase: fake.client, provider, chainKey: 'giwa_sepolia', accountId: ACCOUNT, ethBalanceWei: 10n ** 18n, tokenBalanceUnits: 10n ** 12n, gasBufferWei: 0n, env: ON, log: quiet, ...extra });
const send = (p) => executeNativeSend({ plan: p, provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });
const rows = () => fake.db.tables.fee_ledger;

describe('the merchant fee', () => {
  it('1% of the price, rounded up to the smallest unit; none when it rounds to 0', async () => {
    const cfg = fees.feeConfig(ON);
    const q = await Q.quoteMerchantFee({ provider, asset: 'ETH', amountUnits: PRICE, chainKey: 'giwa_sepolia', cfg });
    assert.deepEqual([q.kind, q.feeUnits, q.feeMicro, q.feeText, q.tierMicro, q.gasEstMicro], ['merchant', String(FEE), '1500000', '$1.50', null, null]);
    assert.equal((await Q.quoteMerchantFee({ provider, asset: 'TUSD', amountUnits: 101n, chainKey: 'giwa_sepolia', cfg })).feeUnits, '2');
    assert.equal(await Q.quoteMerchantFee({ provider, asset: 'TUSD', amountUnits: 0n, chainKey: 'giwa_sepolia', cfg }), null);
  });
});

describe('a chat send to a business', () => {
  it('carries the merchant fee, not the person-to-person fee; the payer amount stays the price', async () => {
    const p = plan();
    assert.deepEqual(await attach(p), { ok: true });
    assert.equal(p.input.amount, '0.05');
    assert.deepEqual(
      [p.fee.kind, p.fee.merchant, p.fee.feeUnits, p.fee.sendHuman, p.fee.totalHuman, ethers.getAddress(p.fee.treasury)],
      ['merchant', true, String(FEE), '0.0495', '0.05', TREASURY]
    );
    assert.equal(SF.planFee(p).merchant, true);
  });

  it('paying your own business, or someone who is not one: the person-to-person fee', async () => {
    fake.db.tables.accounts[1].is_business = false;
    const p = plan();
    await attach(p);
    assert.equal(p.fee.kind, 'p2p');
    seed({ accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, is_business: true, business_terms_version: 'v', business_since: 'x' }] });
    const own = plan({ to: GATOR });
    await attach(own);
    assert.equal(own.fee.kind, 'p2p');
  });

  it('a business that cannot be looked up: refused, nothing planned', async () => {
    const realFrom = fake.client.from.bind(fake.client);
    const broken = { ...fake.client, from: (t) => (t === 'accounts' ? { select: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) } : realFrom(t)) };
    const p = plan();
    const out = await SF.attachSendFee({ plan: p, supabase: broken, provider, chainKey: 'giwa_sepolia', accountId: ACCOUNT, ethBalanceWei: 10n ** 18n, gasBufferWei: 0n, env: ON, log: quiet });
    assert.equal(out.ok, false);
    assert.equal(p.fee, undefined);
  });

  it('the payer sees the price and no fee, in the preview and the receipt, and every check counts the price only', async () => {
    const p = plan();
    await attach(p);
    const preview = formatPlanPreview(p);
    assert.match(preview, /^Amount: {2}0\.05 ETH$/m);
    assert.doesNotMatch(preview, /Fee|They get|Total/);
    const receipt = formatSendReceipt({ ok: true, txHash: HASH }, p);
    assert.match(receipt, /^0\.05 ETH/m);
    assert.doesNotMatch(receipt, /Fee/);
    // Exactly the price is enough: the fee is inside it.
    assert.equal(assertPlanFunded(p, '0.05', '0').ok, true);
    // 0.06 held, 0.01 in Savings: 0.05 spendable, exactly the price.
    fake.db.tables.account_reserves.push({ account_id: ACCOUNT, asset: 'ETH', amount: String(10n ** 16n) });
    assert.equal((await refusePlanSpend(fake.client, ACCOUNT, p, { ethBalanceHuman: '0.06', gasBufferEth: '0' })).ok, true);
  });
});

describe('sending it', () => {
  it('wallet path: the business gets the price less the fee and the treasury the fee, in one operation; the row is the price', async () => {
    const p = plan();
    await attach(p);
    const out = await send(p);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(ownerCalls[0].calls.map((c) => [c.target, c.value]), [[SHOP, PRICE - FEE], [TREASURY, FEE]]);
    assert.equal(fake.db.tables.transfers[0].amount_eth, '0.05');
    assert.deepEqual([rows()[0].kind, rows()[0].state, rows()[0].fee_units], ['merchant', 'charged', String(FEE)]);
  });

  it('a token: the same split in the token', async () => {
    const p = plan({ asset: 'TUSD' });
    await attach(p);
    assert.equal(p.fee.feeUnits, '100000');
    const out = await send(p);
    assert.equal(out.ok, true, JSON.stringify(out));
    const decoded = ownerCalls[0].calls.map((c) => [c.target, ...ERC20.decodeFunctionData('transfer', c.data)]);
    assert.deepEqual(decoded, [[TUSD, SHOP, 9_900_000n], [TUSD, TREASURY, 100_000n]]);
  });

  it('permission path: the business part and the fee, the total being the price', async () => {
    permissionAnswer = async (args) => {
      await args.onBroadcast(HASH);
      return { route: 'permission', txHash: HASH, receipt: { status: 1, blockNumber: 9, gasUsed: 1n, gasPrice: 1n, logs: [] } };
    };
    const p = plan();
    await attach(p);
    assert.equal((await send(p)).ok, true);
    assert.deepEqual([permissionCalls[0].amount, permissionCalls[0].fee], [PRICE - FEE, { to: TREASURY, amount: FEE }]);
    assert.equal(ownerCalls.length, 0);
  });

  it('over the passkey limit: the approval covers the business part, then the fee is collected', async () => {
    permissionAnswer = { route: 'over_cap', available: 10n ** 15n, delegate: '0x' + 'bb'.repeat(20) };
    const p = plan();
    await attach(p);
    await send(p);
    assert.equal(approvalAsks[0].amount, PRICE - FEE);
    assert.equal(rows()[0].state, 'pending');
    const transferId = fake.db.tables.transfers[0].id;
    permissionAnswer = async () => ({ route: 'permission', txHash: FEE_HASH, receipt: { gasUsed: 1n, gasPrice: 1n } });
    await SF.collectApprovedFee({ supabase: fake.client, provider, transferId, accountId: ACCOUNT, gator: GATOR, env: ON, log: quiet });
    const collect = permissionCalls.at(-1);
    assert.deepEqual([collect.to, collect.amount], [TREASURY, FEE]);
    assert.deepEqual([rows()[0].kind, rows()[0].state, rows()[0].tx_hash], ['merchant', 'charged', FEE_HASH]);
  });

  it('the reconciler settles a merchant fee with its payment', async () => {
    const NOW = Date.now();
    const H = '0x' + '04'.repeat(32);
    seed({
      transfers: [{ id: '11111111-1111-4111-8111-111111111111', account_id: ACCOUNT, user_id: USER, status: 'submitted', tx_hash: H, kind: 'transfer', amount_eth: '0.05', asset: 'ETH', created_at: new Date(NOW - 10 * 60e3).toISOString() }],
      fee_ledger: [{ id: 'f1', source_kind: 'transfer', source_id: '11111111-1111-4111-8111-111111111111', kind: 'merchant', state: 'pending', fee_usd_micro: '1500000', asset: 'ETH', fee_units: String(FEE) }],
    });
    const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
    await runReconcileTick({
      supabase: fake.client,
      now: NOW,
      entryPoint: EP,
      gatorOf: () => GATOR,
      userOpSucceeded: () => true,
      provider: { getTransactionReceipt: async () => ({ status: 1, to: EP, logs: [] }) },
      alertAdmins: async () => {},
      notifyAccount: async () => {},
      markRequestPaid: async () => {},
      releaseRequestProcessing: async () => {},
      creditBack: async () => {},
    });
    assert.equal(rows()[0].state, 'charged');
  });
});

describe('what the business is told', () => {
  it('what arrived, and what Flizy kept of the price', async () => {
    const p = plan();
    await attach(p);
    assert.equal(SF.arrivedAmount(p), '0.0495');
    const note = SF.businessFeeNote(p);
    assert.equal(note, 'Flizy kept 0.0005 ETH as the business fee on 0.05 ETH.');
    assert.match(formatReceivedNotice({ amountEth: SF.arrivedAmount(p), asset: 'ETH', fromLabel: '@ada', feeNote: note }), /^You received 0\.0495 ETH from @ada\.\nFlizy kept 0\.0005 ETH as the business fee on 0\.05 ETH\./);
    assert.match(formatRequestPaidNotice({ amountEth: '0.0495', asset: 'ETH', fromLabel: '@ada', feeNote: note }), /0\.0495 ETH from @ada\.\nFlizy kept/);
    assert.match(formatPotContributionNotice({ byLabel: '@ada', amountEth: '0.0495', potName: 'Rent', code: 'P1', feeNote: note }), /into Rent\.\nFlizy kept/);
    // Whole amounts read as people write them; only a trailing ".0" goes.
    const whole = { input: { amount: '10' }, fee: { merchant: true, asset: 'TUSD', feeHuman: '0.1', sendHuman: '9.9', totalHuman: '10.0' } };
    assert.equal(SF.businessFeeNote(whole), 'Flizy kept 0.1 tUSD as the business fee on 10 tUSD.');
    assert.equal(SF.arrivedAmount({ input: { amount: '10' }, fee: { merchant: true, sendHuman: '10.0' } }), '10');
    // A person-to-person payment: the plan's amount, and no note.
    const plain = plan();
    fake.db.tables.accounts[1].is_business = false;
    await attach(plain);
    assert.deepEqual([SF.arrivedAmount(plain), SF.businessFeeNote(plain)], ['0.05', null]);
  });

  it('the chat flow passes them on for a direct payment, a pot and a request', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');
    assert.equal((router.match(/feeNote: businessFeeNote\(plan\)/g) || []).length, 3);
    assert.equal((router.match(/amount: arrivedAmount\(plan\),/g) || []).length, 2);
    assert.match(router, /amount: plan\.fee\?\.merchant \? arrivedAmount\(plan\) : paidAmount,/);
  });
});
