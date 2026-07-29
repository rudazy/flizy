/**
 * One claim, two callers, one payout.
 *
 * The bug this locks down: payout read the claim, checked it was still pending,
 * sent escrow funds, and only then marked it claimed. A user with WhatsApp and
 * Telegram on one account could confirm the same claim on both at once and
 * escrow paid twice for a single hold, with the surplus coming out of other
 * users' pending liability in the shared escrow wallet.
 *
 * Every test here fires both callers concurrently. A test that awaited them in
 * sequence would pass against the broken code and prove nothing.
 *
 * Run: node --test test/claimRace.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const RECIPIENT_ACCOUNT = 'acct-recipient';
const SENDER_ACCOUNT = 'acct-sender';
const PHONE = '2348012345678';
const AMOUNT = '0.5';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const { executeClaimPayout, executeClaimRefund } = require('../lib/engine/executeClaim');
const { getPendingClaimsLiability } = require('../lib/escrowWallet');
const { getDailySentWei } = require('../lib/dailyLimits');

/** Escrow stub that records every send and takes a beat, like a real network. */
function makeEscrow(sends) {
  return {
    address: '0xEscrow',
    async sendTransaction({ to, value }) {
      sends.push({ to, value });
      return {
        hash: `0xtx${sends.length}`,
        async wait() {
          await new Promise((r) => setTimeout(r, 10));
          return { status: 1 };
        },
      };
    },
  };
}

const provider = {
  async getBalance() {
    return 10n ** 18n;
  },
  async getNetwork() {
    return { chainId: 91342 };
  },
};

const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

function seed() {
  fake = createFakeSupabase({
    accounts: [
      { id: RECIPIENT_ACCOUNT, agent_wallet_address: null },
      { id: SENDER_ACCOUNT, agent_wallet_address: null },
    ],
    claims: [
      {
        id: 'claim-1',
        from_account_id: SENDER_ACCOUNT,
        to_wa_hint: PHONE,
        amount_eth: AMOUNT,
        status: 'pending',
        chain_id: 91342,
        claim_token: 'tok',
        created_at: new Date().toISOString(),
      },
    ],
  });
}

beforeEach(seed);

describe('a claim can only be paid out once', () => {
  it('pays one of two concurrent claimers and refuses the other', async () => {
    const sends = [];
    const args = {
      claimId: 'claim-1',
      toAccountId: RECIPIENT_ACCOUNT,
      toWaSender: PHONE,
      toWaPhone: PHONE,
      provider,
      chain,
      escrowWallet: makeEscrow(sends),
    };

    const [a, b] = await Promise.all([
      executeClaimPayout({ ...args }),
      executeClaimPayout({ ...args }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);

    assert.equal(winners.length, 1, 'exactly one payout should succeed');
    assert.equal(losers.length, 1);
    assert.equal(sends.length, 1, 'escrow must be touched once, not twice');
    assert.equal(sends[0].value, 500000000000000000n);
    assert.match(losers[0].error, /already being processed/i);
    assert.equal(fake.db.tables.claims[0].status, 'claimed');
  });

  it('does not let a refund and a payout both drain the same hold', async () => {
    const sends = [];
    const escrowWallet = makeEscrow(sends);

    const [payout, refund] = await Promise.all([
      executeClaimPayout({
        claimId: 'claim-1',
        toAccountId: RECIPIENT_ACCOUNT,
        toWaSender: PHONE,
        toWaPhone: PHONE,
        provider,
        chain,
        escrowWallet,
      }),
      executeClaimRefund({
        claimId: 'claim-1',
        fromAccountId: SENDER_ACCOUNT,
        provider,
        chain,
        escrowWallet,
      }),
    ]);

    const okCount = [payout, refund].filter((r) => r.ok).length;
    assert.equal(okCount, 1, 'the sender cancelling and the recipient claiming cannot both win');
    assert.equal(sends.length, 1, 'escrow must pay once');
    assert.ok(['claimed', 'cancelled'].includes(fake.db.tables.claims[0].status));
  });

  it('refunds once when the sender cancels twice at the same moment', async () => {
    const sends = [];
    const args = {
      claimId: 'claim-1',
      fromAccountId: SENDER_ACCOUNT,
      provider,
      chain,
      escrowWallet: makeEscrow(sends),
    };

    const [a, b] = await Promise.all([
      executeClaimRefund({ ...args }),
      executeClaimRefund({ ...args }),
    ]);

    assert.equal([a, b].filter((r) => r.ok).length, 1);
    assert.equal(sends.length, 1);
    assert.equal(fake.db.tables.claims[0].status, 'cancelled');
  });

  it('leaves a losing caller with a message that does not imply funds arrived', async () => {
    const sends = [];
    const args = {
      claimId: 'claim-1',
      toAccountId: RECIPIENT_ACCOUNT,
      toWaSender: PHONE,
      toWaPhone: PHONE,
      provider,
      chain,
      escrowWallet: makeEscrow(sends),
    };
    const [a, b] = await Promise.all([
      executeClaimPayout({ ...args }),
      executeClaimPayout({ ...args }),
    ]);
    const loser = [a, b].find((r) => !r.ok);
    // The old code said "Payout failed. Try again shortly." while the money had
    // in fact been sent, which invited the retry that doubled the payout.
    assert.doesNotMatch(loser.error, /try again/i);
  });
});

describe('a claim already in flight is not payable', () => {
  it('refuses a payout when the row is held in processing', async () => {
    fake.db.tables.claims[0].status = 'processing';
    const sends = [];
    const result = await executeClaimPayout({
      claimId: 'claim-1',
      toAccountId: RECIPIENT_ACCOUNT,
      toWaSender: PHONE,
      toWaPhone: PHONE,
      provider,
      chain,
      escrowWallet: makeEscrow(sends),
    });
    assert.equal(result.ok, false);
    assert.equal(sends.length, 0);
  });
});

describe('in-flight claims still count as money owed', () => {
  it('counts processing toward escrow liability', async () => {
    fake.db.tables.claims[0].status = 'processing';
    const liability = await getPendingClaimsLiability();
    assert.equal(liability.count, 1);
    assert.equal(liability.liabilityWei, 500000000000000000n);
  });

  it('counts processing toward the daily send total', async () => {
    fake.db.tables.claims[0].status = 'processing';
    const spent = await getDailySentWei(SENDER_ACCOUNT);
    assert.equal(spent, 500000000000000000n);
  });

  it('still counts pending, so the fix did not drop the old behaviour', async () => {
    const liability = await getPendingClaimsLiability();
    assert.equal(liability.liabilityWei, 500000000000000000n);
    const spent = await getDailySentWei(SENDER_ACCOUNT);
    assert.equal(spent, 500000000000000000n);
  });

  it('ignores settled claims', async () => {
    fake.db.tables.claims[0].status = 'cancelled';
    const liability = await getPendingClaimsLiability();
    assert.equal(liability.count, 0);
    assert.equal(liability.liabilityWei, 0n);
  });
});
