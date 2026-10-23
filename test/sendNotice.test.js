/**
 * The "Sending ..." chat line comes from the engine at the moment money can
 * move (lib/engine/executeTransfer.js, onSending), not before the checks.
 *
 * What is pinned: an over-cap send is never announced, it goes straight to the
 * approval message; a send through the permission or the owner key is announced
 * exactly once, before it is broadcast; a send the checks stop is never
 * announced; and a notice that fails never stops a payment. At the library
 * level, beforeSend runs only on the permission route.
 *
 * Run: node --test test/sendNotice.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const ACCOUNT = 'acct-notice';
const USER = 'user-notice';
const TO = '0x1111111111111111111111111111111111111111';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const gatorExecute = require('../lib/gatorExecute');
const redeem = require('../lib/custody/redeem');
const approvals = require('../lib/custody/approvals');
const C = require('../lib/custody/delegations');
const realTrySend = redeem.trySendWithPermission;

let events;
let permission = async () => null;
redeem.trySendWithPermission = async (args) => permission(args);
approvals.createApproval = async () => ({ id: 'ap', url: 'https://flizy.app/approve/AbCdEfGhIjKlMnOpQrStUv', expiresAt: new Date() });
gatorExecute.executeGatorCall = async () => {
  events.push('owner-send');
  return { txHash: '0x' + '0e'.repeat(32), receipt: { status: 1 } };
};
gatorExecute.gatorGasReserveWei = async () => 0n;

const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { predictGatorAddress } = require('../lib/gatorAccount');
const GATOR = predictGatorAddress(ACCOUNT);
const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

let balance;
const provider = {
  async getNetwork() {
    return { chainId: 91342n };
  },
  async getBalance() {
    return balance;
  },
};

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
  });
  events = [];
  balance = 10n ** 18n;
  permission = async () => null;
});

const plan = () => ({
  intent: 'SEND',
  expiresAt: Date.now() + 60000,
  input: { amount: '0.05', asset: 'ETH', recipientLabel: 'john' },
  route: { kind: 'native_transfer', toAddress: TO, fromAddress: GATOR },
  actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
});
const send = (onSending = async () => events.push('Sending')) =>
  executeNativeSend({ plan: plan(), provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client, onSending });

describe('the engine says "Sending" only when money can move', () => {
  it('an over-cap send is never announced: straight to the approval message', async () => {
    permission = async () => ({ route: 'over_cap', available: 10n ** 16n, delegate: '0x' + 'bb'.repeat(20) });
    const out = await send();
    assert.deepEqual(events, []);
    assert.equal(out.approvalPending, true);
    assert.match(out.error, /^This is more than your passkey allows today/);
  });

  it('through the permission: announced once, before the relayer sends', async () => {
    permission = async ({ beforeSend }) => {
      await beforeSend();
      events.push('relayer-send');
      return { txHash: '0x' + 'aa'.repeat(32), receipt: { status: 1 }, route: 'permission' };
    };
    const out = await send();
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(events, ['Sending', 'relayer-send']);
  });

  it('on the owner key: announced once, before the owner call', async () => {
    const out = await send();
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(events, ['Sending', 'owner-send']);
  });

  it('a send the checks stop is never announced', async () => {
    balance = 0n;
    const out = await send();
    assert.equal(out.ok, false);
    assert.deepEqual(events, []);
  });

  it('a notice that fails never stops the payment', async () => {
    const out = await send(async () => {
      throw new Error('chat down');
    });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(events, ['owner-send']);
  });
});

describe('beforeSend in the permission decision', () => {
  const relayer = ethers.Wallet.createRandom();
  const WALLET = ethers.getAddress('0x' + 'aa'.repeat(20));
  const ENFORCER = new ethers.Interface(['function getAvailableAmount(bytes32,address,bytes) view returns (uint256,bool,uint256)']);
  function row() {
    const [{ delegation }] = C.buildDelegations({ account: WALLET, delegate: relayer.address, signedAt: 1_790_000_000, salts: { ETH: 7n, FLZ: 8n, TUSD: 9n } });
    return {
      account_id: ACCOUNT,
      symbol: 'ETH',
      gator: delegation.delegator,
      delegate: delegation.delegate,
      salt: '7',
      caveats: delegation.caveats,
      digest: C.delegationDigest(delegation),
      signature: '0x' + '11'.repeat(100),
      status: 'active',
      expires_at: new Date(Date.now() + 86400e3).toISOString(),
    };
  }
  const chainWith = (available) => ({
    call: async () => ENFORCER.encodeFunctionResult('getAvailableAmount', [available, false, 1n]),
    estimateGas: async () => 100000n,
    getFeeData: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }),
    getBalance: async () => 10n ** 18n,
    getTransactionCount: async () => 0,
    getNetwork: async () => ({ chainId: 91342n }),
    broadcastTransaction: async () => events.push('broadcast'),
    waitForTransaction: async () => ({ status: 1 }),
  });
  const decide = (available) => {
    const saved = process.env.CUSTODY_RELAYER_KEY;
    process.env.CUSTODY_RELAYER_KEY = relayer.privateKey;
    return realTrySend({
      supabase: createFakeSupabase({ custody_delegations: [row()] }).client,
      provider: chainWith(available),
      accountId: ACCOUNT,
      wallet: WALLET,
      symbol: 'ETH',
      amount: 10n ** 16n,
      to: TO,
      beforeSend: async () => events.push('beforeSend'),
      log: { warn() {}, info() {} },
    }).finally(() => {
      process.env.CUSTODY_RELAYER_KEY = saved;
    });
  };

  it('runs before the broadcast when the permission takes the send', async () => {
    assert.equal((await decide(10n ** 17n)).route, 'permission');
    assert.deepEqual(events, ['beforeSend', 'broadcast']);
  });

  it('never runs over the cap', async () => {
    assert.equal((await decide(1n)).route, 'over_cap');
    assert.deepEqual(events, []);
  });
});
