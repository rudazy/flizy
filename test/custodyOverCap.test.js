/**
 * Rule 2: an over-cap chat send from a secured account never falls back to the
 * owner key (lib/engine/executeTransfer.js). It opens a passkey approval for
 * exactly that payment and chat says plainly that it was not sent; a request
 * or pot payment, which cannot wait, is refused. Nothing moves either way.
 *
 * The permission call, the approval store and the owner executor are replaced
 * with recorders; the database is the in-memory fake.
 *
 * Run: node --test test/custodyOverCap.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const ACCOUNT = 'acct-over';
const USER = 'user-over';
const TO = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x' + 'bb'.repeat(20);

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const gatorExecute = require('../lib/gatorExecute');
const redeem = require('../lib/custody/redeem');
const approvals = require('../lib/custody/approvals');
const C = require('../lib/custody/delegations');
const calls = { owner: [], approvals: [] };
let available = 10n ** 17n - 10n ** 16n;
let approvalFails = false;
redeem.trySendWithPermission = async () => ({ route: 'over_cap', available, delegate: RELAYER });
approvals.createApproval = async (args) => {
  calls.approvals.push(args);
  if (approvalFails) throw new Error('db down');
  return { id: 'ap-1', url: 'https://flizy.app/approve/AbCdEfGhIjKlMnOpQrStUv', expiresAt: new Date() };
};
gatorExecute.executeGatorCall = async (args) => {
  calls.owner.push(args);
  return { txHash: '0x' + '0e'.repeat(32), receipt: { status: 1 } };
};
gatorExecute.gatorGasReserveWei = async () => 0n;

const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { predictGatorAddress } = require('../lib/gatorAccount');
const GATOR = predictGatorAddress(ACCOUNT);
const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const provider = {
  async getNetwork() {
    return { chainId: 91342n };
  },
  async getBalance() {
    return 10n ** 18n;
  },
  async call({ data }) {
    const fn = ERC20.parseTransaction({ data });
    if (fn.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [6]);
    return ERC20.encodeFunctionResult('balanceOf', [10n ** 12n]);
  },
};

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
  });
  calls.owner = [];
  calls.approvals = [];
  available = 10n ** 17n - 10n ** 16n;
  approvalFails = false;
});

const user = () => ({ id: USER, balance_eth: 1, is_admin: false });
const plan = (over = {}) => ({
  intent: 'SEND',
  expiresAt: Date.now() + 60000,
  input: { amount: '0.2', asset: 'ETH', recipientLabel: 'john' },
  route: { kind: 'native_transfer', toAddress: TO, fromAddress: GATOR },
  actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
  ...over,
});

describe('an over-cap ETH send', () => {
  it('opens an approval for exactly this payment and never touches the owner key', async () => {
    const out = await executeNativeSend({ plan: plan(), provider, chain, user: user(), supabase: fake.client });
    assert.equal(calls.owner.length, 0, 'no owner-key fallback');
    assert.equal(out.ok, false);
    assert.equal(out.submitted, false);
    assert.equal(out.approvalPending, true);
    const a = calls.approvals[0];
    assert.deepEqual(
      [a.accountId, a.gator, a.delegate, a.symbol, a.to, a.amount, a.amountDisplay, a.recipientLabel],
      [ACCOUNT, GATOR, RELAYER, 'ETH', TO, ethers.parseEther('0.2'), '0.2 ETH', 'john']
    );
    assert.equal(a.transferId, fake.db.tables.transfers[0].id, 'the approval is tied to the transfer row');
  });

  it('says plainly that it was not sent, how to approve, and how to cancel', async () => {
    const out = await executeNativeSend({ plan: plan(), provider, chain, user: user(), supabase: fake.client });
    assert.match(out.error, /^This is more than your passkey allows today \(0\.09 ETH left of 0\.1 ETH\), so it was not sent\./);
    assert.match(out.error, /approve it with your passkey within 10 minutes:\nhttps:\/\/flizy\.app\/approve\/[A-Za-z0-9_-]{22}/);
    assert.match(out.error, /Reply cancel to stop it\.$/);
    const row = fake.db.tables.transfers[0];
    assert.deepEqual([row.status, row.error], ['pending', 'Waiting for passkey approval.']);
  });

  it('a request or pot payment cannot wait: refused, no approval, no owner key', async () => {
    for (const over of [{ paymentRequestId: 'req-1' }, { potId: 'pot-1' }]) {
      calls.approvals = [];
      const out = await executeNativeSend({ plan: plan(over), provider, chain, user: user(), supabase: fake.client });
      assert.equal(out.ok, false);
      assert.equal(out.submitted, false);
      assert.match(out.error, /so it was not sent\. Payments for requests and pots cannot wait for a passkey approval yet\./);
      assert.equal(calls.approvals.length, 0);
    }
    assert.equal(calls.owner.length, 0);
  });

  it('if the approval cannot be opened, it is refused, still never on the owner key', async () => {
    approvalFails = true;
    const out = await executeNativeSend({ plan: plan(), provider, chain, user: user(), supabase: fake.client });
    assert.equal(out.ok, false);
    assert.match(out.error, /approval could not be opened, so it was not sent/);
    assert.equal(calls.owner.length, 0);
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
  });
});

describe('an over-cap token send', () => {
  it('tUSD opens an approval in raw units with the right allowance line', async () => {
    available = 20n * 10n ** 6n;
    const out = await executeNativeSend({
      plan: plan({
        input: { amount: '75', asset: 'TUSD', tokenAddress: C.ASSETS.TUSD.token, recipientLabel: '@kemi' },
        route: { kind: 'erc20_transfer', toAddress: TO, tokenAddress: C.ASSETS.TUSD.token, fromAddress: GATOR },
      }),
      provider,
      chain,
      user: user(),
    });
    assert.equal(calls.owner.length, 0);
    assert.deepEqual([calls.approvals[0].symbol, calls.approvals[0].amount, calls.approvals[0].amountDisplay], ['TUSD', 75n * 10n ** 6n, '75 tUSD']);
    assert.match(out.error, /\(20\.0 tUSD left of 50\.0 tUSD\)/);
  });
});
