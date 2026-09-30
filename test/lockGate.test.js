/**
 * The hard-lock gate has to sit above every pending flow, not below it.
 *
 * "add wallet" is a two-step flow: address, then a name. The name step used to
 * be handled at the very top of the router, above the lock gate, so a flow
 * started before the owner sent "flizy lock" could still be finished after it.
 * That adds a trusted payout destination while the session is locked, which is
 * the one thing lock exists to stop.
 *
 * Run: node --test test/lockGate.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
const { hashPin } = require('../lib/cryptoPin');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

// lib/runtime opens an RPC provider and demands real env; stub it for unit tests
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
    supabase: {
      from: (table) => fake.client.from(table),
      rpc: (name, args) => fake.client.rpc(name, args),
    },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');

const TG_ID = '778899123';
const WALLET = '0x1111111111111111111111111111111111111111';

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
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-a',
        email: 'a@example.com',
        display_name: 'A',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: null,
        unlock_pin_hash: hashPin('4821'),
      },
    ],
    channel_identities: [
      {
        id: 'i1',
        account_id: 'acc-a',
        channel: 'telegram',
        external_id: TG_ID,
        phone_e164: null,
      },
    ],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
  });
}

/** Every trusted row the fake has, whatever table name the lib settled on. */
function trustedRows() {
  return fake.db.tables.trusted_addresses || fake.db.tables.trusted_wallets || [];
}

describe('chat cannot add a payout destination, locked or open', () => {
  beforeEach(() => {
    seed();
    // Pending flows are module state, so one test must not inherit another's.
    router.discardPendingFlows(`telegram:${TG_ID}`);
  });

  it('there is no wallet-add flow left to race the lock', async () => {
    // This block used to prove the gate sat above the pending name step, so a
    // flow opened before a lock could not be finished after it. That race is
    // gone because the flow is gone: chat cannot add a payout destination at
    // all now, locked or open. The weaker guarantee is replaced by a stronger
    // one, so the old assertions are not merely deleted.
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, `/add wallet ${WALLET}`);
    assert.match(sent.join('\n'), /dashboard\/account\?add=/, 'it offers the site instead');
    assert.equal(trustedRows().length, 0, 'unlocked chat must not add a destination');

    sent.length = 0;
    await router.handle(ctx, 'john');
    assert.equal(trustedRows().length, 0, 'the old name step must write nothing');

    await router.handle(ctx, '/lock');
    sent.length = 0;
    await router.handle(ctx, `/add wallet ${WALLET}`);
    assert.equal(trustedRows().length, 0, 'locked chat must not add a destination either');
  });


  it('still lets a locked user unlock, and the name step no longer eats the word', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, `/add wallet ${WALLET}`);
    sent.length = 0;

    // With the flow open, "unlock" used to be swallowed as a wallet label.
    await router.handle(ctx, '/unlock');
    const joined = sent.join('\n');
    assert.ok(!/Added unlock/.test(joined), 'unlock must never become a trusted label');
    assert.match(joined, /Reply with your unlock PIN\./);
  });

  it('lock is never swallowed as the secret the bot is waiting for', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, '/unlock');
    assert.equal(router.pendingFlowFor(ctx.key).unlock, true, 'bot should be awaiting a secret');

    sent.length = 0;
    await router.handle(ctx, '/lock');

    assert.match(sent.join('\n'), /Session locked/);
    assert.equal(fake.db.tables.sessions[0].is_locked, true);
    // And it did not cost the user a failed attempt on their own command.
    assert.equal(Number(fake.db.tables.sessions[0].failed_pin_attempts || 0), 0);
  });
});

describe('the contact-share step is gated too, though it skips handle()', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(`telegram:${TG_ID}`);
  });

  it('refuses to bind a number while the session is locked', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, '/lock');
    sent.length = 0;

    await router.handleSharedPhone(ctx, { phone: '2348012345678', verified: true });

    assert.match(sent.join('\n'), /Session locked/);
    assert.equal(fake.db.tables.channel_identities[0].phone_e164, null);
  });

  it('binds it normally when the session is open', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handleSharedPhone(ctx, { phone: '2348012345678', verified: true });

    assert.match(sent.join('\n'), /Number verified/);
    assert.equal(fake.db.tables.channel_identities[0].phone_e164, '2348012345678');
  });
});

describe('the other pending flows already resume behind the gate', () => {
  beforeEach(() => {
    seed();
    // Pending flows are module state, so one test must not inherit another's.
    router.discardPendingFlows(`telegram:${TG_ID}`);
  });

  it('a locked session cannot confirm a send, claim menu pick, or anything else', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, '/lock');
    sent.length = 0;

    for (const body of ['/confirm', 'confirm', '/claim', '/pay', '/requests', '/send 0.01 to john']) {
      sent.length = 0;
      await router.handle(ctx, body);
      assert.match(
        sent.join('\n'),
        /Session locked/,
        `"${body}" should be refused while the session is locked`
      );
    }
  });
});
