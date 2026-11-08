/**
 * API payouts through the engine's own executors (lib/engine/executeTransfer.js)
 * with `permission: { send, ownerKey: false }`.
 *
 * What is pinned: the platform's allowance sender is the only way money moves.
 * When it sends nothing (no allowance, or over what is left today) the payout
 * is refused with nothing sent: the owner key is never called, no passkey
 * approval is opened, and the transfer row is marked failed. A wallet that is
 * not a smart account, an NFT, and a token with no allowance are refused the
 * same way. Without the option, chat sends behave as before.
 *
 * Run: node --test test/apiPayoutEngine.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const ACCOUNT = 'acct-platform';
const TO = '0x1111111111111111111111111111111111111111';
const OTHER_TOKEN = '0x' + '77'.repeat(20);

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const gatorExecute = require('../lib/gatorExecute');
const redeem = require('../lib/custody/redeem');
const approvals = require('../lib/custody/approvals');
const C = require('../lib/custody/delegations');
const calls = { chatPermission: 0, owner: 0, approval: 0, api: [] };
redeem.trySendWithPermission = async () => {
  calls.chatPermission += 1;
  return null;
};
gatorExecute.executeGatorCall = async () => {
  calls.owner += 1;
  return { txHash: '0x' + '0e'.repeat(32), receipt: { status: 1 } };
};
gatorExecute.gatorGasReserveWei = async () => 0n;
approvals.createApproval = async () => {
  calls.approval += 1;
  return { url: 'https://flizy.app/approve/x' };
};

const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { ALLOWANCE_REASON } = require('../lib/engine/allowance');
const { predictGatorAddress } = require('../lib/gatorAccount');
const GATOR = predictGatorAddress(ACCOUNT);
const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const user = { id: null, balance_eth: 0 };

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

const actor = { accountId: ACCOUNT, waSenderId: 'api', channel: 'api', externalId: 'platform:p1' };
const ethPlan = (amount = '0.01') => ({
  intent: 'SEND',
  expiresAt: Date.now() + 60000,
  input: { amount, asset: 'ETH', recipientLabel: 'john' },
  route: { kind: 'native_transfer', toAddress: TO, fromAddress: GATOR },
  actor,
});
const tokenPlan = (tokenAddress, asset = 'TUSD', amount = '5') => ({
  intent: 'SEND',
  expiresAt: Date.now() + 60000,
  input: { amount, asset, tokenAddress, recipientLabel: 'john' },
  route: { kind: 'erc20_transfer', toAddress: TO, tokenAddress, fromAddress: GATOR },
  actor,
});

let apiImpl;
const apiSend = async (args) => {
  calls.api.push(args);
  return apiImpl(args);
};
const allowanceOnly = { send: apiSend, ownerKey: false };

beforeEach(() => {
  fake = createFakeSupabase({ accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR }], transfers: [] });
  Object.assign(calls, { chatPermission: 0, owner: 0, approval: 0, api: [] });
  apiImpl = async () => null;
});

describe('an API payout spends only through its allowance', () => {
  it('sends through the allowance and records its hash, without the chat permission or the owner key', async () => {
    apiImpl = async (args) => {
      await args.onBroadcast('0x' + 'aa'.repeat(32));
      return { txHash: '0x' + 'aa'.repeat(32), receipt: { status: 1 }, route: 'permission' };
    };
    const out = await executeNativeSend({ plan: ethPlan('0.01'), provider, chain, user, supabase: fake.client, permission: allowanceOnly });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual([calls.api.length, calls.chatPermission, calls.owner], [1, 0, 0]);
    assert.deepEqual([calls.api[0].symbol, calls.api[0].amount, calls.api[0].to], ['ETH', ethers.parseEther('0.01'), TO]);
    assert.equal(fake.db.tables.transfers[0].tx_hash, '0x' + 'aa'.repeat(32));
  });

  it('no allowance: refused, nothing sent, never the owner key', async () => {
    const out = await executeNativeSend({ plan: ethPlan('0.01'), provider, chain, user, supabase: fake.client, permission: allowanceOnly });
    assert.deepEqual([out.ok, out.submitted, out.reason], [false, false, ALLOWANCE_REASON]);
    assert.equal(calls.owner, 0);
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
  });

  it('over what is left today: refused, never a passkey approval, never the owner key', async () => {
    apiImpl = async () => ({ route: 'over_cap', available: 1n });
    for (const plan of [ethPlan('0.5'), tokenPlan(C.ASSETS.TUSD.token, 'TUSD', '500')]) {
      const out = await executeNativeSend({ plan, provider, chain, user, supabase: fake.client, permission: allowanceOnly });
      assert.equal(out.reason, ALLOWANCE_REASON);
    }
    assert.deepEqual([calls.owner, calls.approval], [0, 0]);
  });

  it('a token with no allowance, and an NFT, are refused without asking anything', async () => {
    const tok = await executeNativeSend({ plan: tokenPlan(OTHER_TOKEN, 'DCAT', '5'), provider, chain, user, supabase: fake.client, permission: allowanceOnly });
    assert.equal(tok.reason, ALLOWANCE_REASON);
    const nft = await executeNativeSend({
      plan: { ...ethPlan(), route: { kind: 'erc721_transfer', toAddress: TO } },
      provider,
      chain,
      user,
      supabase: fake.client,
      permission: allowanceOnly,
    });
    assert.equal(nft.reason, ALLOWANCE_REASON);
    assert.deepEqual([calls.api.length, calls.owner], [0, 0]);
  });

  it('a wallet that is not a smart account cannot hold an allowance: refused, never its own key', async () => {
    fake.db.tables.accounts[0].agent_wallet_address = '0x' + '99'.repeat(20);
    const out = await executeNativeSend({ plan: ethPlan('0.01'), provider, chain, user, supabase: fake.client, permission: allowanceOnly });
    assert.equal(out.reason, ALLOWANCE_REASON);
    assert.equal(out.submitted, false);
  });

  it('without the option, a chat send is unchanged: chat permission first, then the owner key', async () => {
    const out = await executeNativeSend({ plan: ethPlan('0.01'), provider, chain, user: { id: 'u1', balance_eth: 1 }, supabase: fake.client });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual([calls.chatPermission, calls.owner, calls.api.length], [1, 1, 0]);
  });
});
