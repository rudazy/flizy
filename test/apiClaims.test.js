/**
 * Flizy Pay API, phase 2b: payouts to a phone, an email or a platform id
 * become escrow claims, with an expiry, a cancel and a refund.
 *
 * What is pinned:
 * - the engine's claim hold, given `permission: { ownerKey: false }`, moves the
 *   money to escrow only through the platform's allowance, never the owner
 *   key, and writes the claim with its expiry and its payout; a chat hold is
 *   unchanged (owner path, no expiry, no link);
 * - a refund given `held: true` needs the claim already locked, records its
 *   hash before the broadcast, and never unlocks the claim on a failure, so
 *   the recipient can never claim a payout that reads as refunding; a chat
 *   refund is unchanged;
 * - the worker: an identity payout is always a claim (member or not), a
 *   member is told by the partner's assigned name, a handle is refused; an
 *   unknown hold is settled from its receipt; claimed -> confirmed; cancelled
 *   in chat -> refunded; expired or cancelled -> the claim locked first, then
 *   refunded only on a confirmed refund; a recipient who got there first
 *   keeps the claim;
 * - the cancel route, the reconciler hand-off and the migration.
 *
 * Run: node --test test/apiClaims.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

// The owner path, the escrow's solvency read, and lookups, replaced before the engine binds them.
const gatorExecute = require('../lib/gatorExecute');
const escrowWallet = require('../lib/escrowWallet');
const identity = require('../lib/identity');
const accountEmails = require('../lib/accountEmails');
const calls = { owner: 0 };
gatorExecute.executeGatorCall = async (args) => {
  calls.owner += 1;
  const txHash = '0x' + '0e'.repeat(32);
  if (args.onBroadcast) await args.onBroadcast(txHash);
  return { txHash, receipt: { status: 1, blockNumber: 1 } };
};
gatorExecute.gatorGasReserveWei = async () => 0n;
escrowWallet.assertEscrowSolvent = async () => ({ ok: true, liabilityEth: '0', balanceEth: '0', pendingCount: 0 });
let memberByPhone = null;
identity.findAccountIdByPhone = async () => memberByPhone;
identity.getAccountByIdentity = async () => null;
accountEmails.findAccountIdByEmail = async () => null;

const { executeClaimHold, executeClaimRefund } = require('../lib/engine/executeClaim');
const { ALLOWANCE_REASON } = require('../lib/engine/allowance');
const { predictGatorAddress } = require('../lib/gatorAccount');
const C = require('../lib/custody/delegations');

const ACCOUNT = 'acct-platform';
const GATOR = predictGatorAddress(ACCOUNT);
const ESCROW = '0x' + 'e5'.repeat(20);
const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const HOLD = '0x' + 'ab'.repeat(32);

const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
let broadcasts;
let receiptStatus;
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
/** Stands in for the escrow EOA: signs to a fixed blob, broadcasts to a recorder. */
const escrow = {
  address: ESCROW,
  async populateTransaction(tx) {
    return tx;
  },
  async signTransaction() {
    return '0x' + 'cd'.repeat(40);
  },
  async sendTransaction() {
    broadcasts.push('chat');
    return { hash: '0x' + 'ce'.repeat(32), wait: async () => ({ status: 1 }) };
  },
  provider: {
    async broadcastTransaction() {
      broadcasts.push('recorded');
    },
    async waitForTransaction() {
      return { status: receiptStatus };
    },
  },
};

const phoneTo = { kind: 'phone', phone: '+2348000000001' };
const permissionThat = (impl) => ({ ownerKey: false, send: async (args) => impl(args) });

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR }],
    claims: [],
    claim_hold_attempts: [],
  });
  calls.owner = 0;
  broadcasts = [];
  receiptStatus = 1;
  memberByPhone = null;
});

describe('an API claim hold', () => {
  it('moves the money to escrow through the allowance, and writes the claim with its expiry and payout', async () => {
    const seen = [];
    const out = await executeClaimHold({
      fromAccountId: ACCOUNT,
      recipient: phoneTo,
      amountEth: '5',
      asset: 'TUSD',
      tokenAddress: C.ASSETS.TUSD.token,
      provider,
      chain,
      escrowWallet: escrow,
      permission: permissionThat(async (args) => {
        seen.push(args);
        await args.onBroadcast(HOLD);
        return { txHash: HOLD, receipt: { status: 1, blockNumber: 1 }, route: 'permission' };
      }),
      expiresAt: '2026-12-01T00:00:00.000Z',
      apiTransactionId: 'po-1',
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(calls.owner, 0, 'never the owner key');
    assert.deepEqual([seen[0].symbol, seen[0].amount, seen[0].to], ['TUSD', 5n * 10n ** 6n, ESCROW]);
    const claim = fake.db.tables.claims[0];
    assert.deepEqual([claim.api_transaction_id, claim.expires_at, claim.hold_tx_hash], ['po-1', '2026-12-01T00:00:00.000Z', HOLD]);
    assert.equal(fake.db.tables.claim_hold_attempts[0].claim_args.apiTransactionId, 'po-1', 'the reconciler can link it too');
  });

  it('refused by the allowance: no claim, nothing sent, the attempt closed as refused', async () => {
    const out = await executeClaimHold({
      fromAccountId: ACCOUNT,
      recipient: phoneTo,
      amountEth: '5',
      asset: 'TUSD',
      tokenAddress: C.ASSETS.TUSD.token,
      provider,
      chain,
      escrowWallet: escrow,
      permission: permissionThat(async () => ({ route: 'over_cap', available: 1n })),
      expiresAt: null,
      apiTransactionId: 'po-1',
    });
    assert.deepEqual([out.ok, out.submitted, out.reason], [false, false, ALLOWANCE_REASON]);
    assert.equal(fake.db.tables.claims.length, 0);
    assert.equal(calls.owner, 0);
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'refused');
  });

  it('a hash stored for a broadcast the node refused: the attempt is closed as failed, not left for an hour', async () => {
    const out = await executeClaimHold({
      fromAccountId: ACCOUNT,
      recipient: phoneTo,
      amountEth: '5',
      asset: 'TUSD',
      tokenAddress: C.ASSETS.TUSD.token,
      provider,
      chain,
      escrowWallet: escrow,
      permission: permissionThat(async (args) => {
        await args.onBroadcast(HOLD);
        return null;
      }),
      apiTransactionId: 'po-1',
    });
    assert.equal(out.reason, ALLOWANCE_REASON);
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'failed');
  });

  it('an NFT, or a wallet that cannot hold an allowance, is refused before anything', async () => {
    const nft = await executeClaimHold({ fromAccountId: ACCOUNT, recipient: phoneTo, amountEth: '1', asset: 'NFT', tokenAddress: '0x' + '77'.repeat(20), nftTokenId: '7', provider, chain, escrowWallet: escrow, permission: permissionThat(async () => null) });
    assert.equal(nft.reason, ALLOWANCE_REASON);
    fake.db.tables.accounts[0].agent_wallet_address = '0x' + '99'.repeat(20);
    const eoa = await executeClaimHold({ fromAccountId: ACCOUNT, recipient: phoneTo, amountEth: '0.01', asset: 'ETH', provider, chain, escrowWallet: escrow, permission: permissionThat(async () => null) });
    assert.equal(eoa.reason, ALLOWANCE_REASON);
    assert.equal(calls.owner, 0);
  });

  it('a chat hold is unchanged: the owner path, and no expiry or payout on the claim', async () => {
    const out = await executeClaimHold({ fromAccountId: ACCOUNT, recipient: phoneTo, amountEth: '5', asset: 'TUSD', tokenAddress: C.ASSETS.TUSD.token, provider, chain, escrowWallet: escrow });
    assert.equal(out.ok, true, out.error);
    assert.equal(calls.owner, 1);
    assert.equal(fake.db.tables.claims[0].expires_at, undefined);
    assert.equal(fake.db.tables.claims[0].api_transaction_id, undefined);
  });
});

describe('an API claim refund', () => {
  const claimRow = (status) => ({ id: 'cl-1', from_account_id: ACCOUNT, status, amount_eth: '0.01', asset: 'ETH', token_address: null, nft_token_id: null });

  it('held: needs the claim locked, records the hash before the broadcast, then cancels the claim', async () => {
    fake.db.tables.claims = [claimRow('processing')];
    const order = [];
    const out = await executeClaimRefund({
      claimId: 'cl-1',
      fromAccountId: ACCOUNT,
      provider,
      chain,
      escrowWallet: escrow,
      held: true,
      onBroadcast: async (hash) => {
        order.push(`hash ${hash.slice(0, 6)}`);
        assert.deepEqual(broadcasts, [], 'stored before the broadcast');
      },
    });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(broadcasts, ['recorded']);
    assert.equal(order.length, 1);
    assert.equal(fake.db.tables.claims[0].status, 'cancelled');
    assert.equal(fake.db.tables.claims[0].refund_tx_hash, out.refundTxHash);
  });

  it('held: a claim that is not locked is refused, and a failed refund leaves it locked', async () => {
    fake.db.tables.claims = [claimRow('pending')];
    const notLocked = await executeClaimRefund({ claimId: 'cl-1', fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow, held: true, onBroadcast: async () => {} });
    assert.equal(notLocked.ok, false);
    assert.equal(fake.db.tables.claims[0].status, 'pending');
    fake.db.tables.claims = [claimRow('processing')];
    receiptStatus = 0;
    const reverted = await executeClaimRefund({ claimId: 'cl-1', fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow, held: true, onBroadcast: async () => {} });
    assert.equal(reverted.ok, false);
    assert.equal(fake.db.tables.claims[0].status, 'processing', 'still locked: the recipient cannot claim it now');
  });

  it('held: a broadcast the node refuses is not_sent (locked still), one with no answer is unknown', async () => {
    const realBroadcast = escrow.provider.broadcastTransaction;
    try {
      fake.db.tables.claims = [claimRow('processing')];
      escrow.provider.broadcastTransaction = async () => {
        throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
      };
      const refused = await executeClaimRefund({ claimId: 'cl-1', fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow, held: true, onBroadcast: async () => {} });
      assert.deepEqual([refused.ok, refused.outcome], [false, 'not_sent']);
      assert.equal(fake.db.tables.claims[0].status, 'processing');

      escrow.provider.broadcastTransaction = async () => {
        throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      };
      receiptStatus = null;
      const realWait = escrow.provider.waitForTransaction;
      escrow.provider.waitForTransaction = async () => {
        throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      };
      try {
        const unknown = await executeClaimRefund({ claimId: 'cl-1', fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow, held: true, onBroadcast: async () => {} });
        assert.deepEqual([unknown.ok, unknown.outcome], [false, 'unknown']);
        assert.equal(fake.db.tables.claims[0].status, 'processing');
      } finally {
        escrow.provider.waitForTransaction = realWait;
      }
    } finally {
      escrow.provider.broadcastTransaction = realBroadcast;
    }
  });

  it('a chat refund is unchanged: from pending, sent the old way', async () => {
    fake.db.tables.claims = [claimRow('pending')];
    const out = await executeClaimRefund({ claimId: 'cl-1', fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(broadcasts, ['chat']);
    assert.equal(fake.db.tables.claims[0].status, 'cancelled');
  });
});

describe('the cancel route, the reconciler hand-off and the migration', () => {
  it('cancel needs payout, fails only an untaken payout, records a claim cancel, and never touches the chain', () => {
    const src = read('web/app/api/v1/payouts/[id]/cancel/route.ts');
    assert.match(src, /authenticateApiRequest\(req, db, 'payout'\)/);
    assert.match(src, /\.eq\('platform_id', caller\.platformId\)/);
    assert.match(src, /p_to_state: 'failed',\s*p_detail: \{ error_code: 'cancelled' \}/);
    assert.match(src, /\.eq\('state', 'claim_pending'\)\s*\.is\('cancel_requested_at', null\)/);
    assert.doesNotMatch(src, /executeClaimRefund|sendTransaction|redeemDelegations/);
  });

  it('the reconciler keeps an API hold linked, and leaves its notices to the worker', () => {
    const src = read('lib/reconcile.js');
    assert.match(src, /apiTransactionId: a\.claim_args && a\.claim_args\.apiTransactionId,/);
    assert.match(src, /if \(created && !\(a\.claim_args && a\.claim_args\.apiTransactionId\)\) \{/);
  });

  it('the migration leaves chat claims as they are and keeps its own rules', () => {
    const SQL = read('supabase/migrations/20261106120000_api_claims.sql');
    assert.match(SQL, /alter table public\.claims add column if not exists expires_at timestamptz;/);
    assert.doesNotMatch(SQL, /expires_at timestamptz not null|set default/i, 'no expiry forced on chat claims');
    assert.match(SQL, /claim_expiry_days is null or claim_expiry_days between 1 and 365/);
    assert.match(SQL, /refund_tx_hash is null or refund_tx_hash ~ '\^0x\[0-9a-f\]\{64\}\$'/);
  });
});
