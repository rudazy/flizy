/**
 * The claimadmin lockout fails closed.
 *
 * Link codes tolerate a missing or failing attempt counter because 50 bits of
 * entropy stand behind it. The admin secret has no such floor, so when the
 * counter cannot be read, or an attempt cannot be counted, the attempt is
 * refused before the secret is compared, even when the secret is right.
 *
 * Run: node --test test/claimAdminFailClosed.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
const GOOD_SECRET = 'a-very-long-setup-secret-0123456789';
process.env.ADMIN_SETUP_SECRET = GOOD_SECRET;

let fake = createFakeSupabase();

/** Which link_code_attempts operations fail: 'none', 'read' or 'write'. */
let counterFails = 'none';

/** A query builder whose every chain step returns itself and whose result is an error. */
function failingBuilder() {
  const result = { data: null, error: { message: 'connection reset', code: 'XX000' } };
  const builder = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return (resolve) => resolve(result);
        if (prop === 'maybeSingle' || prop === 'single') return async () => result;
        return () => builder;
      },
    }
  );
  return builder;
}

function from(table) {
  if (table === 'link_code_attempts' && counterFails === 'read') return failingBuilder();
  if (table === 'link_code_attempts' && counterFails === 'write') {
    const real = fake.client.from(table);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'upsert' || prop === 'update' || prop === 'insert') return () => failingBuilder();
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return fake.client.from(table);
}

mockSupabaseModule({ from, rpc: (name, args) => fake.client.rpc(name, args) });

const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: {
      id: 'giwa_sepolia',
      name: 'GIWA Sepolia',
      chainId: 91342,
      nativeSymbol: 'ETH',
      rpcUrl: 'http://localhost:0',
    },
    supabase: { from, rpc: (name, args) => fake.client.rpc(name, args) },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const { linkLockState, recordFailedLinkAttempt } = require('../lib/linkAttempts');

const TG_ID = '553311888';

function ctxFor(sent) {
  return {
    channel: 'telegram',
    externalId: TG_ID,
    key: `telegram:${TG_ID}`,
    raw: {},
    reply: async (text) => {
      sent.push(text);
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
  };
}

function seed() {
  counterFails = 'none';
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-a',
        email: 'a@example.com',
        display_name: 'A',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x9999999999999999999999999999999999999999',
        unlock_pin_hash: null,
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-a', channel: 'telegram', external_id: TG_ID, phone_e164: null },
    ],
    users: [{ id: 'u1', phone: `telegram:${TG_ID}`, account_id: 'acc-a', balance_eth: 0, is_admin: false }],
    link_code_attempts: [],
    sessions: [],
  });
  router.discardPendingFlows(`telegram:${TG_ID}`);
}

const users = () => fake.db.tables.users || [];
const isAdminNow = () => Boolean(users()[0] && users()[0].is_admin);

describe('claimadmin with an unusable attempt counter', () => {
  beforeEach(seed);

  it('refuses the right secret when the counter cannot be read', async () => {
    counterFails = 'read';
    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);
    const out = sent.join('\n');

    assert.match(out, /Admin setup is unavailable right now/);
    assert.doesNotMatch(out, /Invalid setup secret|now an admin/i, 'the secret was never compared');
    assert.equal(isAdminNow(), false);
  });

  it('refuses the right secret when the attempt cannot be counted', async () => {
    counterFails = 'write';
    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);
    const out = sent.join('\n');

    assert.match(out, /Admin setup is unavailable right now/);
    assert.equal(isAdminNow(), false);
  });

  it('gives a wrong guess the same answer, so the outage leaks nothing', async () => {
    counterFails = 'write';
    const sent = [];
    await router.handle(ctxFor(sent), '/claimadmin wrong-guess-entirely');
    assert.match(sent.join('\n'), /Admin setup is unavailable right now/);
    assert.doesNotMatch(sent.join('\n'), /Invalid setup secret/);
  });

  it('works again once the counter is back', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);
    assert.match(sent.join('\n'), /now an admin/i);
    assert.equal(isAdminNow(), true);
    const row = (fake.db.tables.link_code_attempts || [])[0];
    assert.equal(Number(row?.failed_attempts || 0), 0, 'the up-front count is cleared on a match');
  });
});

describe('link codes keep failing open', () => {
  beforeEach(seed);

  it('reports unlocked but degraded when the counter cannot be read', async () => {
    counterFails = 'read';
    const lock = await linkLockState('telegram', TG_ID);
    assert.equal(lock.locked, false);
    assert.equal(lock.degraded, true);
  });

  it('reports an unrecorded failure without a lock', async () => {
    counterFails = 'write';
    const counted = await recordFailedLinkAttempt('telegram', TG_ID);
    assert.equal(counted.recorded, false);
    assert.equal(counted.lockedForMs, 0);
  });

  it('reports a recorded failure when the counter works', async () => {
    const counted = await recordFailedLinkAttempt('telegram', TG_ID);
    assert.equal(counted.recorded, true);
    assert.equal(counted.attempts, 1);
  });
});
