/**
 * The Flizy fee on a chat claim hold (Phase 0d, part 3b):
 * lib/engine/executeClaim.js executeClaimHold and lib/reconcile.js.
 *
 * Covers: the fee is on record as pending before the hold can move, and with
 * no record nothing is sent; the owner path sends the hold and the fee in one
 * UserOp (ETH by value, a token by transfer); the permission path is handed
 * the fee; a hold that lands charges it, one refused or reverted waives it,
 * one with no answer leaves it pending; a fee is never taken by a plain wallet
 * or with an NFT; and the reconciler charges or waives the pending fee of a
 * hold it settles, keyed by the hold attempt.
 *
 * Run: node --test test/claimHoldFee.test.js
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
const ESCROW = '0x4444444444444444444444444444444444444444';
const TREASURY = ethers.getAddress('0x' + '7e'.repeat(20));
const FLZ = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';

// The owner executor, the escrow and the permission sender are recorders.
const calls = { owner: [], permission: [] };
let ownerAnswer;
let permissionAnswer = null;
const gatorPath = require.resolve('../lib/gatorExecute');
const realGator = require('../lib/gatorExecute');
require.cache[gatorPath].exports = {
  ...realGator,
  gatorGasReserveWei: async () => 0n,
  executeGatorCall: async (args) => {
    calls.owner.push(args);
    if (args.onBroadcast) await args.onBroadcast(HASH);
    return ownerAnswer(args);
  },
};
const escrowPath = require.resolve('../lib/escrowWallet');
require.cache[escrowPath] = {
  id: escrowPath,
  filename: escrowPath,
  loaded: true,
  exports: {
    getEscrowWallet: () => ({ address: ESCROW }),
    assertEscrowSolvent: async () => ({ ok: true, balanceEth: '1', liabilityEth: '0', pendingCount: 0 }),
  },
};
const redeem = require('../lib/custody/redeem');
redeem.trySendWithPermission = async (args) => {
  calls.permission.push(args);
  if (typeof permissionAnswer === 'function') return permissionAnswer(args);
  return permissionAnswer;
};

const { predictGatorAddress } = require('../lib/gatorAccount');
const { executeClaimHold } = require('../lib/engine/executeClaim');
const { runReconcileTick, resetFlaggedCursors, SETTLE_AFTER_MS } = require('../lib/reconcile');

const ACCOUNT = 'acct-claimfee';
const USER = 'user-claimfee';
const GATOR = predictGatorAddress(ACCOUNT);
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const ERC20 = new ethers.Interface([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);
const provider = {
  async getNetwork() {
    return { chainId: 91342 };
  },
  async getBalance() {
    return 10n ** 18n;
  },
  async call({ data }) {
    const fn = ERC20.parseTransaction({ data });
    if (fn.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [18]);
    return ERC20.encodeFunctionResult('balanceOf', [10n ** 24n]);
  },
};

/** A fee as lib/engine/sendFee.js planFee hands it on. */
const FEE_UNITS = 6_666_666_666_667n;
const fee = (asset = 'ETH') => ({
  units: FEE_UNITS,
  treasury: TREASURY,
  quote: {
    kind: 'p2p',
    asset,
    feeUnits: String(FEE_UNITS),
    feeMicro: '20000',
    tierMicro: '20000',
    gasEstMicro: '9000',
    absorbMicro: '0',
    gasOverTier: false,
    priceMicro: '3000000000',
    priceSource: 'FEE_ETH_USD_RATE',
    pricedAt: new Date().toISOString(),
  },
});

function seed(extra = {}) {
  calls.owner = [];
  calls.permission = [];
  permissionAnswer = null;
  ownerAnswer = () => ({ txHash: HASH, receipt: { status: 1, blockNumber: 9, logs: [] } });
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
    claims: [],
    claim_hold_attempts: [],
    fee_ledger: [],
    account_reserves: [],
    ...extra,
  });
}

const hold = (over = {}) =>
  executeClaimHold({
    fromAccountId: ACCOUNT,
    fromWaSender: '2348000000000',
    toWaHint: '2348099999999',
    amountEth: '0.01',
    asset: 'ETH',
    tokenAddress: null,
    provider,
    chain,
    escrowWallet: { address: ESCROW },
    fee: fee(),
    ...over,
  });

const ledger = () => fake.db.tables.fee_ledger;
const attempt = () => fake.db.tables.claim_hold_attempts[0];

describe('a chat claim hold with a fee', () => {
  beforeEach(() => seed());

  it('owner path, ETH: the hold and the fee in one UserOp, and the fee charged once it lands', async () => {
    const r = await hold();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.owner.length, 1);
    const sent = calls.owner[0];
    assert.equal(sent.target, undefined);
    assert.equal(sent.calls.length, 2);
    assert.equal(sent.calls[0].target, ESCROW);
    assert.equal(sent.calls[0].value, 10n ** 16n);
    assert.deepEqual(sent.calls[1], { target: TREASURY, value: FEE_UNITS, data: '0x' });
    assert.equal(ledger().length, 1);
    assert.deepEqual(
      [ledger()[0].source_kind, ledger()[0].source_id, ledger()[0].account_id, ledger()[0].state, ledger()[0].tx_hash],
      ['claim', attempt().id, ACCOUNT, 'charged', HASH]
    );
    assert.equal(attempt().status, 'held');
  });

  it('owner path, a token: the fee is a token transfer to the treasury', async () => {
    const r = await hold({ asset: 'FLZ', tokenAddress: FLZ, amountEth: '10', fee: fee('FLZ') });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [, feeCall] = calls.owner[0].calls;
    assert.equal(feeCall.target, FLZ);
    assert.equal(feeCall.value, 0n);
    const decoded = ERC20.decodeFunctionData('transfer', feeCall.data);
    assert.deepEqual([decoded[0], decoded[1]], [TREASURY, FEE_UNITS]);
    assert.equal(ledger()[0].state, 'charged');
  });

  it('permission path: the fee is handed to the permission send, never the owner key', async () => {
    permissionAnswer = async (args) => {
      await args.onBroadcast(HASH);
      return { route: 'permission', txHash: HASH, receipt: { status: 1, blockNumber: 9, logs: [] } };
    };
    const r = await hold();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.owner.length, 0);
    assert.deepEqual(calls.permission[0].fee, { to: TREASURY, amount: FEE_UNITS });
    assert.equal(ledger()[0].state, 'charged');
  });

  it('the fee row is pending before anything is sent', async () => {
    ownerAnswer = () => {
      assert.equal(ledger().length, 1);
      assert.equal(ledger()[0].state, 'pending');
      return { txHash: HASH, receipt: { status: 1, blockNumber: 9, logs: [] } };
    };
    assert.equal((await hold()).ok, true);
  });

  it('over the passkey limit, or a limit that cannot be read: refused and the fee waived', async () => {
    for (const route of ['over_cap', 'unchecked']) {
      seed();
      permissionAnswer = { route, available: 0n, delegate: '0x' + 'bb'.repeat(20) };
      const r = await hold();
      assert.equal(r.ok, false);
      assert.equal(calls.owner.length, 0);
      assert.equal(ledger()[0].state, 'waived', route);
    }
  });

  it('reverted on-chain: the fee waived', async () => {
    ownerAnswer = () => ({ txHash: HASH, receipt: { status: 0, blockNumber: 9, logs: [] } });
    const r = await hold();
    assert.equal(r.ok, false);
    assert.equal(ledger()[0].state, 'waived');
  });

  it('the send failed before it went out: waived; sent with no answer yet: left pending', async () => {
    ownerAnswer = () => {
      throw new realGator.GatorExecError('send_failed', 'refused by the node', { submitted: false });
    };
    assert.equal((await hold()).ok, false);
    assert.equal(ledger()[0].state, 'waived');
    seed();
    ownerAnswer = () => {
      throw new realGator.GatorExecError('timeout', 'no receipt yet', { submitted: true, txHash: HASH });
    };
    await hold();
    assert.equal(ledger()[0].state, 'pending');
  });

  it('the fee cannot be recorded: nothing is sent', async () => {
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = (t) => {
      const q = realFrom(t);
      if (t === 'fee_ledger') q.upsert = () => Promise.resolve({ error: { message: 'down' } });
      return q;
    };
    const r = await hold();
    assert.equal(r.ok, false);
    assert.equal(r.submitted, false);
    assert.match(r.error, /Could not record the fee, so nothing was sent/);
    assert.equal(calls.owner.length + calls.permission.length, 0);
    assert.equal(attempt().status, 'refused');
  });

  it('a plain wallet or an NFT hold with a fee: refused before anything is recorded', async () => {
    seed({ accounts: [{ id: ACCOUNT, agent_wallet_address: '0x' + '55'.repeat(20), balance_eth: 1 }] });
    const plain = await hold();
    assert.equal(plain.ok, false);
    assert.equal(plain.submitted, false);
    seed();
    const nft = await hold({ nftTokenId: '7', tokenAddress: FLZ, asset: 'NFT' });
    assert.equal(nft.ok, false);
    assert.equal(nft.submitted, false);
    assert.equal(calls.owner.length + calls.permission.length, 0);
    assert.equal(ledger().length, 0);
  });

  it('a payout allowance with a fee: refused, nothing sent or recorded', async () => {
    const r = await hold({ permission: { ownerKey: false, send: async () => { throw new Error('must not send'); } } });
    assert.equal(r.ok, false);
    assert.equal(r.submitted, false);
    assert.equal(calls.owner.length + calls.permission.length, 0);
    assert.equal(ledger().length, 0);
  });

  it('no fee: the hold is a single call, as before, and the ledger untouched', async () => {
    const r = await hold({ fee: null });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.owner[0].target, ESCROW);
    assert.equal(calls.owner[0].calls, undefined);
    assert.equal(ledger().length, 0);
  });
});

describe('the reconciler and a claim hold fee', () => {
  const NOW = Date.parse('2026-11-15T12:00:00Z');
  const H = '0x' + '03'.repeat(32);
  const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  const row = (status) => ({
    id: 'a1',
    from_account_id: ACCOUNT,
    chain_id: 91342,
    status,
    amount_eth: '0.01',
    asset: 'ETH',
    token_address: null,
    nft_token_id: null,
    claim_args: { fromWaSender: '2348000000000', recipient: { kind: 'phone', phone: '2348099999999' } },
    hold_tx_hash: H,
    claim_id: null,
    created_at: new Date(NOW - SETTLE_AFTER_MS - 1000).toISOString(),
  });
  const pending = () => ({ id: 'f1', source_kind: 'claim', source_id: 'a1', kind: 'p2p', state: 'pending', fee_usd_micro: '20000' });
  const tick = (outcome) =>
    runReconcileTick({
      supabase: fake.client,
      now: NOW,
      entryPoint: EP,
      gatorOf: () => GATOR,
      userOpSucceeded: (receipt) => receipt.inner === true,
      provider: { getTransactionReceipt: async () => ({ status: 1, to: EP, inner: outcome === 'success', logs: [] }) },
      alertAdmins: async () => {},
      createClaim: async (p) => {
        const claim = { id: 'c1', hold_tx_hash: p.holdTxHash, amount_eth: p.amountEth };
        fake.db.tables.claims.push(claim);
        return { claim };
      },
      notifyAccount: async () => {},
      notifyClaimRecipient: async () => {},
    });

  for (const status of ['submitted', 'unknown']) {
    it(`a ${status} hold that landed: its fee charged`, async () => {
      resetFlaggedCursors();
      seed({ claim_hold_attempts: [row(status)], fee_ledger: [pending()] });
      await tick('success');
      assert.equal(attempt().status, 'held');
      assert.equal(ledger()[0].state, 'charged');
      assert.equal(ledger()[0].tx_hash, H);
    });

    it(`a ${status} hold that reverted: its fee waived`, async () => {
      resetFlaggedCursors();
      seed({ claim_hold_attempts: [row(status)], fee_ledger: [pending()] });
      await tick('reverted');
      assert.equal(attempt().status, 'failed');
      assert.equal(ledger()[0].state, 'waived');
      assert.equal(ledger()[0].waive_reason, 'reverted');
    });
  }

  it("another source's fee is never touched", async () => {
    resetFlaggedCursors();
    seed({ claim_hold_attempts: [row('submitted')], fee_ledger: [{ ...pending(), source_kind: 'transfer' }] });
    await tick('success');
    assert.equal(ledger()[0].state, 'pending');
  });
});
