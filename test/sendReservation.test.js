/**
 * A send reserves credit before the money moves, and gives it back if nothing
 * reached the chain.
 *
 * Reserving first is what stops two concurrent sends passing on the same funds.
 * The risk it introduces is the mirror image: credit taken for a transfer that
 * never happened. So every failure before submission must return the
 * reservation, and every failure after submission must not, because the
 * transfer may still confirm.
 *
 * Run: node --test test/sendReservation.test.js
 */

// Credit enforcement is read from env when lib/config loads, so set it first.
process.env.ENFORCE_CREDIT = 'true';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const ACCOUNT = 'acct-sender';
const USER = 'user-1';
const TO = '0x1111111111111111111111111111111111111111';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const { executeNativeSend } = require('../lib/engine/executeTransfer');

const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

function seed(balance = 1) {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: null, balance_eth: balance }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: balance, is_admin: false }],
    transfers: [],
  });
}

const balanceNow = () => Number(fake.db.tables.users[0].balance_eth);

function plan(amount = '0.4') {
  return {
    intent: 'SEND',
    expiresAt: Date.now() + 60000,
    input: { amount, asset: 'ETH', recipientLabel: 'john' },
    route: { kind: 'native_transfer', toAddress: TO, fromAddress: TO },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
  };
}

const user = () => ({ id: USER, balance_eth: balanceNow(), is_admin: false });

/** Provider whose behaviour is chosen per test. */
function makeProvider({ balanceWei = 10n ** 18n, failOn = null } = {}) {
  return {
    async getNetwork() {
      if (failOn === 'network') throw new Error('rpc down');
      return { chainId: 91342 };
    },
    async getBalance() {
      if (failOn === 'balance') throw new Error('rpc down');
      return balanceWei;
    },
  };
}

beforeEach(() => seed(1));

describe('failures before submission return the reservation', () => {
  it('gives credit back when the network check fails', async () => {
    const result = await executeNativeSend({
      plan: plan('0.4'),
      provider: makeProvider({ failOn: 'network' }),
      chain,
      user: user(),
      supabase: fake.client,
    });
    assert.equal(result.ok, false);
    assert.equal(result.submitted, false);
    assert.equal(Number(balanceNow().toFixed(10)), 1, 'reservation must be returned');
  });

  it('gives credit back when the agent wallet cannot cover the send', async () => {
    const result = await executeNativeSend({
      plan: plan('0.4'),
      provider: makeProvider({ balanceWei: 1n }),
      chain,
      user: user(),
      supabase: fake.client,
    });
    assert.equal(result.ok, false);
    assert.equal(result.submitted, false);
    assert.match(result.error, /Not enough ETH in your agent wallet/);
    assert.equal(Number(balanceNow().toFixed(10)), 1);
  });
});

describe('the reservation is the authority, not the passed-in balance', () => {
  it('refuses when the real balance cannot cover it, even if the caller says otherwise', async () => {
    seed(0.1);
    const result = await executeNativeSend({
      plan: plan('0.4'),
      provider: makeProvider(),
      // A stale read, exactly what the old code trusted.
      user: { id: USER, balance_eth: 5, is_admin: false },
      chain,
      supabase: fake.client,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Not enough spendable credit/);
    assert.equal(Number(balanceNow().toFixed(10)), 0.1, 'balance untouched');
  });

  it('lets only one of two concurrent sends reserve the same funds', async () => {
    seed(0.5);
    // 0.5 cannot fund two sends of 0.4. Both fail at the network step, so any
    // reservation that was taken comes back. What matters is that exactly one
    // send ever held the funds. The refusal can come from the advisory check or
    // from the guarded decrement depending on interleaving, and either is a
    // correct refusal, so this asserts the outcome rather than the wording.
    const results = await Promise.all([
      executeNativeSend({
        plan: plan('0.4'),
        provider: makeProvider({ failOn: 'network' }),
        chain,
        user: user(),
        supabase: fake.client,
      }),
      executeNativeSend({
        plan: plan('0.4'),
        provider: makeProvider({ failOn: 'network' }),
        chain,
        user: user(),
        supabase: fake.client,
      }),
    ]);

    const refusedForFunds = results.filter((r) => /credit/i.test(r.error || ''));
    assert.equal(refusedForFunds.length, 1, 'exactly one send must be refused the funds');
    assert.equal(
      results.filter((r) => r.submitted === false && !/credit/i.test(r.error || '')).length,
      1,
      'the other should have reached the chain attempt and failed there'
    );
    assert.equal(Number(balanceNow().toFixed(10)), 0.5, 'every reservation was resolved');
  });
});
