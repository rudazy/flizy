/**
 * The Flizy fee on a chat send (Phase 0d, part 2): lib/engine/sendFee.js and
 * the send executors.
 *
 * Covers: with fees off nothing changes a plan; on without a treasury, no send
 * is planned; the fee on top when it fits, out of the amount when it does not
 * (Savings and the gas reserve counted), refused below the fee; a request or
 * pot payment pays it on top only, never from the amount; a claim hold carries
 * it, with a preview that says it is not refunded; no fee on an NFT or from an
 * older plain wallet; the preview and the
 * receipt name the fee; the plan-stage checks count it; the executors send the
 * payment and the fee in one UserOp, hand the fee to the permission path, and
 * write one ledger row once it lands; and the router quotes the fee before its
 * balance checks and holds the daily limit to the total at CONFIRM.
 *
 * Run: node --test test/sendFee.test.js
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
const calls = { owner: [], permission: [] };
const gatorExecute = require('../lib/gatorExecute');
gatorExecute.executeGatorCall = async (args) => {
  calls.owner.push(args);
  if (args.onBroadcast) await args.onBroadcast(HASH);
  return { txHash: HASH, receipt: { status: 1, blockNumber: 9, logs: [] } };
};
gatorExecute.gatorGasReserveWei = async () => 0n;
const redeem = require('../lib/custody/redeem');
redeem.trySendWithPermission = async (args) => {
  calls.permission.push(args);
  return null;
};

const SF = require('../lib/engine/sendFee');
const { assertPlanFunded, formatPlanPreview, formatClaimPlanPreview } = require('../lib/engine/plan');
const { formatSendReceipt } = require('../lib/engine/receipt');
const { refusePlanSpend } = require('../lib/reserves');
const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { predictGatorAddress } = require('../lib/gatorAccount');

const ACCOUNT = 'acct-fee';
const USER = 'user-fee';
const GATOR = predictGatorAddress(ACCOUNT);
const TO = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x' + '7e'.repeat(20);
const TUSD = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
const ON = { FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY };
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const quiet = { warn() {}, info() {}, error() {} };
/** $0.02 of ETH at $3,000, rounded up. */
const ETH_FEE = 6_666_666_666_667n;

const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const provider = {
  async getNetwork() {
    return { chainId: 91342n };
  },
  async getBalance() {
    return 10n ** 18n;
  },
  // 0.01 gwei: a calm network, so the fee is the tier fee.
  async getFeeData() {
    return { maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n };
  },
  async call({ data }) {
    const fn = ERC20.parseTransaction({ data });
    if (fn.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [6]);
    return ERC20.encodeFunctionResult('balanceOf', [10n ** 12n]);
  },
};

function plan(over = {}) {
  const token = over.asset === 'TUSD';
  return {
    intent: 'SEND',
    expiresAt: Date.now() + 60_000,
    input: { amount: over.amount || (token ? '10' : '0.01'), asset: over.asset || 'ETH', recipientLabel: 'john', tokenAddress: token ? TUSD : null },
    route: { kind: token ? 'erc20_transfer' : 'native_transfer', toAddress: TO, fromAddress: over.fromAddress || GATOR, tokenAddress: token ? TUSD : null, chainName: 'GIWA Sepolia', chainId: 91342 },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
    estimated: {},
    paymentRequestId: over.paymentRequestId,
    potId: over.potId,
    policyChecks: {},
    createdAt: Date.now(),
  };
}

function seed(extra = {}) {
  calls.owner = [];
  calls.permission = [];
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
    fee_ledger: [],
    account_reserves: [],
    ...extra,
  });
}
beforeEach(() => seed());

const attach = (p, extra = {}) =>
  SF.attachSendFee({ plan: p, supabase: fake.client, provider, chainKey: 'giwa_sepolia', accountId: ACCOUNT, ethBalanceWei: 10n ** 18n, gasBufferWei: 0n, env: ON, log: quiet, ...extra });

/** A chat claim hold plan, shaped as lib/engine/plan.js buildClaimPlan makes it. */
function claimPlan(over = {}) {
  const token = over.asset === 'TUSD';
  return {
    intent: 'CLAIM_HOLD',
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60_000,
    input: { amount: over.amount || (token ? '10' : '0.01'), asset: over.asset || 'ETH', recipient: '+2348099999999', recipientKind: 'phone' },
    route: { kind: 'claim_hold', chainId: 91342, chainName: 'GIWA Sepolia', fromAddress: GATOR, toWaHint: '2348099999999', tokenAddress: token ? TUSD : null, nftTokenId: over.nftTokenId || null },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
    policyChecks: {},
  };
}

describe('a claim hold at plan time', () => {
  it('ETH: the fee on top, in the preview, with the not-refunded line', async () => {
    const p = claimPlan();
    assert.deepEqual(await attach(p), { ok: true });
    assert.deepEqual([p.fee.asset, p.fee.feeUnits, p.fee.feeFromAmount], ['ETH', String(ETH_FEE), false]);
    const preview = formatClaimPlanPreview(p);
    assert.match(preview, /Fee: {5}0\.000006666666666667 ETH \(\$0\.02\)/);
    assert.match(preview, /Total: {3}0\.010006666666666667 ETH/);
    assert.match(preview, /The fee is not refunded if the claim is cancelled or expires\./);
    assert.equal(SF.planFee(p).units, ETH_FEE);
  });

  it('a token hold pays the fee in the token, from the token balance', async () => {
    const p = claimPlan({ asset: 'TUSD' });
    assert.deepEqual(await attach(p, { tokenBalanceUnits: 100n * 10n ** 6n }), { ok: true });
    assert.deepEqual([p.fee.asset, p.fee.feeUnits], ['TUSD', '20000']);
    const none = claimPlan({ asset: 'TUSD' });
    assert.equal((await attach(none, { tokenBalanceUnits: null })).ok, false);
  });

  it('no fee on an NFT hold, and fees off leaves the preview as it was', async () => {
    const nft = claimPlan({ nftTokenId: '7' });
    assert.deepEqual(await attach(nft), { ok: true });
    assert.equal(nft.fee, undefined);
    const off = claimPlan();
    assert.deepEqual(await attach(off, { env: {} }), { ok: true });
    assert.equal(off.fee, undefined);
    assert.doesNotMatch(formatClaimPlanPreview(off), /Fee:|not refunded/);
  });

  it('the planning handler quotes it and the router hands it to the hold', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const handler = read('lib/handlers/claims.js');
    const body = handler.slice(handler.indexOf('async function openClaimHold('));
    const quoted = body.indexOf('await attachSendFee(');
    assert.ok(quoted > 0 && quoted < body.indexOf('await refusePlanSpend('), 'before the balance checks');
    const router = read('lib/router.js');
    const call = router.slice(router.indexOf('await executeClaimHold({'));
    assert.ok(call.slice(0, call.indexOf('});')).includes('fee: planFee(plan),'));
  });
});

describe('at plan time', () => {
  it('fees off: the plan is left exactly as it was', async () => {
    const p = plan();
    const before = JSON.stringify(p);
    assert.deepEqual(await attach(p, { env: { FEE_TREASURY_ADDRESS: 'junk', FEE_P2P_BASE_USD: 'junk' } }), { ok: true });
    assert.equal(JSON.stringify(p), before);
  });

  it('fees on without a treasury: no send is planned', async () => {
    const out = await attach(plan(), { env: { FEES_ENABLED: 'true' } });
    assert.equal(out.ok, false);
    assert.match(out.message, /nothing was sent/);
  });

  it('the fee on top when it fits, and the preview and the receipt name it', async () => {
    const p = plan();
    assert.deepEqual(await attach(p), { ok: true });
    assert.deepEqual(
      [p.input.amount, p.fee.feeUnits, p.fee.feeText, p.fee.feeFromAmount, p.fee.treasury, p.fee.sendUnits],
      ['0.01', String(ETH_FEE), '$0.02', false, ethers.getAddress(TREASURY), String(10n ** 16n)]
    );
    const preview = formatPlanPreview(p);
    assert.match(preview, /Fee: {5}0\.000006666666666667 ETH \(\$0\.02\)/);
    assert.match(preview, /Total: {3}0\.010006666666666667 ETH/);
    assert.doesNotMatch(preview, /They get/);
    assert.match(formatSendReceipt({ ok: true, txHash: HASH }, p), /Fee: 0\.000006666666666667 ETH \(\$0\.02\)/);
  });

  it('out of the amount when the spendable balance does not cover both, Savings counted', async () => {
    seed({ account_reserves: [{ account_id: ACCOUNT, asset: 'ETH', amount: String(99n * 10n ** 16n) }] });
    // 1 ETH held, 0.99 in Savings: 0.01 spendable, exactly the amount.
    const p = plan();
    assert.deepEqual(await attach(p), { ok: true });
    assert.equal(p.fee.feeFromAmount, true);
    assert.equal(p.input.amount, ethers.formatEther(10n ** 16n - ETH_FEE));
    assert.equal(p.fee.totalHuman, '0.01');
    const preview = formatPlanPreview(p);
    assert.match(preview, /taken from the 0\.01 ETH you asked to send/);
    assert.match(preview, /They get: 0\.009993333333333333 ETH/);
  });

  it('refused below the fee, or for an amount no bigger than the fee', async () => {
    const below = await attach(plan(), { ethBalanceWei: 10n ** 12n });
    assert.deepEqual(below, { ok: false, message: 'Your balance is below the $0.02 fee, so nothing was sent.' });
    // An amount equal to the fee, with a balance that covers it but not it plus the fee.
    const tiny = await attach(plan({ amount: ethers.formatEther(ETH_FEE) }), { ethBalanceWei: 10n ** 13n });
    assert.equal(tiny.ok, false);
    assert.match(tiny.message, /has to be more than the \$0\.02 fee/);
  });

  it('a request or pot payment pays the fee on top, and is refused rather than paid short', async () => {
    for (const over of [{ paymentRequestId: 'req-1' }, { potId: 'pot-1' }]) {
      const p = plan(over);
      assert.deepEqual(await attach(p), { ok: true });
      assert.equal(p.fee.feeFromAmount, false);
      assert.equal(p.input.amount, '0.01');
      assert.equal(p.fee.totalUnits, String(10n ** 16n + ETH_FEE));
      // Exactly the amount spendable: the fee would come from it, so nothing is planned.
      const short = plan(over);
      const out = await attach(short, { ethBalanceWei: 10n ** 16n });
      assert.equal(out.ok, false);
      assert.match(out.message, /^This needs 0\.01 ETH plus the \$0\.02 fee \(0\.000006666666666667 ETH\), and your balance does not cover both, so nothing was sent\.$/);
      assert.equal(short.fee, undefined);
      assert.equal(short.input.amount, '0.01');
    }
  });

  it('no fee from an older plain wallet', async () => {
    const p = plan({ fromAddress: '0x' + '55'.repeat(20) });
    assert.deepEqual(await attach(p), { ok: true });
    assert.equal(p.fee, undefined);
  });

  it('the balance and Savings checks count the fee', async () => {
    const p = plan();
    await attach(p);
    // Enough for the amount and the gas, not the fee.
    assert.equal(assertPlanFunded(p, '0.01', '0').ok, false);
    assert.equal(assertPlanFunded(p, '0.010006666666666667', '0').ok, true);
    // With 0.01 ETH in Savings out of 0.02, the payment fits Available only without its fee.
    fake.db.tables.account_reserves.push({ account_id: ACCOUNT, asset: 'ETH', amount: String(10n ** 16n) });
    const fence = await refusePlanSpend(fake.client, ACCOUNT, p, { ethBalanceHuman: '0.02', gasBufferEth: '0' });
    assert.equal(fence.ok, false);
    p.fee = undefined;
    assert.equal((await refusePlanSpend(fake.client, ACCOUNT, p, { ethBalanceHuman: '0.02', gasBufferEth: '0' })).ok, true);
  });
});

describe('at send time', () => {
  it('ETH: the payment and the fee in one UserOp, the fee offered to the permission path, one ledger row', async () => {
    const p = plan();
    await attach(p);
    const out = await executeNativeSend({ plan: p, provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(calls.permission[0].fee, { to: ethers.getAddress(TREASURY), amount: ETH_FEE });
    const sent = calls.owner[0];
    assert.equal(sent.target, undefined);
    assert.deepEqual(sent.calls.map((c) => [c.target, c.value]), [[TO, 10n ** 16n], [ethers.getAddress(TREASURY), ETH_FEE]]);
    const rows = fake.db.tables.fee_ledger;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].source_kind, rows[0].kind, rows[0].asset, rows[0].fee_units, rows[0].tx_hash], ['transfer', 'p2p', 'ETH', String(ETH_FEE), HASH]);
    assert.equal(rows[0].source_id, fake.db.tables.transfers[0].id);
  });

  it('tUSD: two token transfers in one UserOp, the fee in tUSD units', async () => {
    const p = plan({ asset: 'TUSD' });
    await attach(p, { tokenBalanceUnits: 100n * 10n ** 6n });
    assert.equal(p.fee.feeUnits, '20000');
    const out = await executeNativeSend({ plan: p, provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });
    assert.equal(out.ok, true, JSON.stringify(out));
    const ERC = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const decoded = calls.owner[0].calls.map((c) => [c.target, ...ERC.decodeFunctionData('transfer', c.data)]);
    assert.deepEqual(decoded, [[TUSD, TO, 10n * 10n ** 6n], [TUSD, ethers.getAddress(TREASURY), 20000n]]);
    assert.equal(fake.db.tables.fee_ledger[0].asset, 'TUSD');
  });

  it('without a fee, a send is the single call it always was', async () => {
    const out = await executeNativeSend({ plan: plan(), provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });
    assert.equal(out.ok, true);
    assert.equal(calls.owner[0].target, TO);
    assert.equal(calls.owner[0].calls, undefined);
    assert.equal(calls.permission[0].fee, undefined);
    assert.equal(fake.db.tables.fee_ledger.length, 0);
  });
});

describe('the chat flow', () => {
  const router = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');
  it('the fee is quoted before the balance checks, and the daily limit at CONFIRM counts it', () => {
    const body = router.slice(router.indexOf('async function handleSendResolved('));
    const quote = body.indexOf('await attachSendFee(');
    assert.ok(quote > 0);
    assert.ok(quote < body.indexOf('await refusePlanSpend('), 'before the Savings check');
    assert.ok(quote < body.indexOf('assertPlanFunded('), 'before the funding check');
    assert.ok(quote < body.indexOf('formatPlanPreview(plan)'), 'before the preview');
    assert.ok(router.includes('checkDailySendLimitNow(plan.actor.accountId, plan.fee ? plan.fee.totalHuman : plan.input.amount)'));
  });
});
