/**
 * The chat engine's send path with signed permissions (lib/engine/executeTransfer.js).
 *
 * What is pinned: for a smart-account wallet, a plain ETH, FLZ or tUSD send
 * tries the signed permission first and uses the owner key only when that
 * returned null (nothing was sent that way); a send whose permission outcome is
 * unknown is reported as submitted and never sent again on the owner path; a
 * token with no permission never asks for one.
 *
 * The permission call and the owner executor are replaced with recorders; the
 * database is the in-memory fake.
 *
 * Run: node --test test/custodyEngineRoute.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const ACCOUNT = 'acct-secured';
const USER = 'user-secured';
const TO = '0x1111111111111111111111111111111111111111';
const OTHER_TOKEN = '0x' + '77'.repeat(20);

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

// Replace the two ways money can leave before the engine binds them.
const gatorExecute = require('../lib/gatorExecute');
const redeem = require('../lib/custody/redeem');
const C = require('../lib/custody/delegations');
const calls = { permission: [], owner: [] };
let permissionImpl = async () => null;
redeem.trySendWithPermission = async (args) => {
  calls.permission.push(args);
  return permissionImpl(args);
};
gatorExecute.executeGatorCall = async (args) => {
  calls.owner.push(args);
  const txHash = '0x' + '0e'.repeat(32);
  if (args.onBroadcast) await args.onBroadcast(txHash);
  return { txHash, receipt: { status: 1 } };
};
gatorExecute.gatorGasReserveWei = async () => 0n;

const { executeNativeSend } = require('../lib/engine/executeTransfer');
const { predictGatorAddress } = require('../lib/gatorAccount');
const GATOR = predictGatorAddress(ACCOUNT);
const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
  });
  calls.permission = [];
  calls.owner = [];
  permissionImpl = async () => null;
});

const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);

/** Answers the chain id, balances and the two ERC-20 reads the token path makes. */
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

const user = () => ({ id: USER, balance_eth: 1, is_admin: false });

function ethPlan(amount = '0.01') {
  return {
    intent: 'SEND',
    expiresAt: Date.now() + 60000,
    input: { amount, asset: 'ETH', recipientLabel: 'john' },
    route: { kind: 'native_transfer', toAddress: TO, fromAddress: GATOR },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
  };
}

function tokenPlan(tokenAddress, asset = 'TUSD', amount = '5') {
  return {
    intent: 'SEND',
    expiresAt: Date.now() + 60000,
    input: { amount, asset, tokenAddress, recipientLabel: 'john' },
    route: { kind: 'erc20_transfer', toAddress: TO, tokenAddress, fromAddress: GATOR },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
  };
}

describe('ETH from a smart-account wallet', () => {
  it('goes through the signed permission when it takes the send, and never touches the owner key', async () => {
    permissionImpl = async (args) => {
      await args.onBroadcast('0x' + 'aa'.repeat(32));
      return { txHash: '0x' + 'aa'.repeat(32), receipt: { status: 1 }, route: 'permission' };
    };
    const out = await executeNativeSend({ plan: ethPlan('0.01'), provider, chain, user: user(), supabase: fake.client });
    assert.equal(out.ok, true, out.error);
    assert.equal(calls.permission.length, 1);
    assert.equal(calls.owner.length, 0);
    const p = calls.permission[0];
    assert.deepEqual([p.symbol, p.amount, p.to, p.wallet, p.accountId], ['ETH', ethers.parseEther('0.01'), TO, GATOR, ACCOUNT]);
    assert.equal(fake.db.tables.transfers[0].tx_hash, '0x' + 'aa'.repeat(32), 'the relayer hash is the one recorded');
  });

  it('falls back to the owner key only when the permission sent nothing', async () => {
    const out = await executeNativeSend({ plan: ethPlan('0.5'), provider, chain, user: user(), supabase: fake.client });
    assert.equal(out.ok, true, out.error);
    assert.equal(calls.permission.length, 1);
    assert.equal(calls.owner.length, 1);
    assert.equal(calls.owner[0].value, ethers.parseEther('0.5'));
  });

  it('reports an unknown permission outcome as submitted and never sends again', async () => {
    permissionImpl = async () => {
      throw new gatorExecute.GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet', { submitted: true, txHash: '0x' + 'bb'.repeat(32) });
    };
    const out = await executeNativeSend({ plan: ethPlan('0.01'), provider, chain, user: user(), supabase: fake.client });
    assert.equal(out.ok, false);
    assert.equal(out.submitted, true);
    assert.equal(calls.owner.length, 0, 'no second send on the owner key');
  });
});

describe('tokens from a smart-account wallet', () => {
  it('tUSD asks the permission, in raw units', async () => {
    permissionImpl = async () => ({ txHash: '0x' + 'cc'.repeat(32), receipt: { status: 1 }, route: 'permission' });
    const out = await executeNativeSend({ plan: tokenPlan(C.ASSETS.TUSD.token, 'TUSD', '5'), provider, chain, user: user() });
    assert.equal(out.ok, true, out.error);
    assert.equal(calls.permission.length, 1);
    assert.deepEqual([calls.permission[0].symbol, calls.permission[0].amount], ['TUSD', 5n * 10n ** 6n]);
    assert.equal(calls.owner.length, 0);
  });

  it('a token with no permission goes straight to the owner key', async () => {
    const out = await executeNativeSend({ plan: tokenPlan(OTHER_TOKEN, 'DCAT', '5'), provider, chain, user: user() });
    assert.equal(out.ok, true, out.error);
    assert.equal(calls.permission.length, 0);
    assert.equal(calls.owner.length, 1);
    assert.equal(calls.owner[0].target, ethers.getAddress(OTHER_TOKEN));
  });
});
