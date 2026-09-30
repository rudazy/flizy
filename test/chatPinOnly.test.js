/**
 * Chat takes the unlock PIN, never the account password.
 *
 * A chat message stays in the chat history, on the phone and on the chat
 * provider's servers, and the account password is also the site login. So in
 * every flow that reads a secret from chat, the password is refused even when
 * it is right, the PIN still works, and an account with no PIN is sent to the
 * site to set one. The trade flow is covered in test/tradeSecret.test.js; this
 * file covers the three unlock flows. It also checks that no secret-carrying
 * message reaches the log.
 *
 * Run: node --test test/chatPinOnly.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
const { hashPin, hashPassword } = require('../lib/cryptoPin');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({
  from: (table) => fake.client.from(table),
  rpc: (name, args) => fake.client.rpc(name, args),
});

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
    provider: { getCode: async () => '0x', getBalance: async () => 10n ** 18n },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');

const PIN = '482915';
const PASSWORD = 'Secret1!';
const WITH_PIN = '778899131';
const NO_PIN = '778899132';

function ctxFor(externalId, sent) {
  return {
    channel: 'telegram',
    externalId,
    key: `telegram:${externalId}`,
    raw: {},
    reply: async (text) => {
      sent.push(text);
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
  };
}

function account(id, pin) {
  return {
    id,
    email: `${id}@example.com`,
    display_name: id,
    username: id.replace(/-/g, ''),
    balance_eth: 0,
    is_admin: false,
    agent_wallet_address: '0x9999999999999999999999999999999999999999',
    unlock_pin_hash: pin ? hashPin(PIN) : null,
    password_hash: hashPassword(PASSWORD),
  };
}

function seed() {
  fake = createFakeSupabase({
    accounts: [account('acc-pin', true), account('acc-nopin', false)],
    channel_identities: [
      { id: 'i1', account_id: 'acc-pin', channel: 'telegram', external_id: WITH_PIN, phone_e164: null },
      { id: 'i2', account_id: 'acc-nopin', channel: 'telegram', external_id: NO_PIN, phone_e164: null },
    ],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
    transfers: [],
    claims: [],
  });
}

function sessionRow(externalId) {
  return (fake.db.tables.sessions || []).find((s) => s.external_id === externalId);
}

/** Lock the chat, the way a person does before handing the phone over. */
async function lockedChat(externalId) {
  const sent = [];
  const ctx = ctxFor(externalId, sent);
  await router.handle(ctx, '/lock');
  assert.equal(sessionRow(externalId)?.is_locked, true, 'the chat did not lock');
  sent.length = 0;
  return { ctx, sent };
}

const SET_PIN = /Set an unlock PIN on the site first: \S+\/dashboard\/account/;

beforeEach(() => {
  seed();
  router.discardPendingFlows(`telegram:${WITH_PIN}`);
  router.discardPendingFlows(`telegram:${NO_PIN}`);
});

describe('flow 1: one-shot unlock', () => {
  it('refuses the account password, even when it is right', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, `/unlock ${PASSWORD}`);
    assert.match(sent.join('\n'), /Unlock failed\. Wrong PIN\./);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
  });

  it('unlocks with the PIN', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, `/unlock ${PIN}`);
    assert.match(sent.join('\n'), /Session unlocked/);
    assert.equal(sessionRow(WITH_PIN).is_locked, false);
  });

  it('sends an account with no PIN to the site', async () => {
    const { ctx, sent } = await lockedChat(NO_PIN);
    await router.handle(ctx, `/unlock ${PASSWORD}`);
    assert.match(sent.join('\n'), SET_PIN);
    assert.equal(sessionRow(NO_PIN).is_locked, true);
  });
});

describe('flow 2: unlock, then the secret as the next message', () => {
  it('asks for the PIN only', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/unlock');
    const prompt = sent.join('\n');
    assert.match(prompt, /Reply with your unlock PIN\./);
    assert.doesNotMatch(prompt, /password/i);
  });

  it('refuses the account password, even when it is right', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/unlock');
    sent.length = 0;
    await router.handle(ctx, PASSWORD);
    assert.match(sent.join('\n'), /Unlock failed\. Wrong PIN\./);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
  });

  it('unlocks with the PIN', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/unlock');
    await router.handle(ctx, PIN);
    assert.match(sent.join('\n'), /Session unlocked/);
  });

  it('sends an account with no PIN to the site', async () => {
    const { ctx, sent } = await lockedChat(NO_PIN);
    await router.handle(ctx, '/unlock');
    sent.length = 0;
    await router.handle(ctx, PASSWORD);
    assert.match(sent.join('\n'), SET_PIN);
  });
});

describe('flow 3: the hard-lock gate', () => {
  it('points at the PIN, not the password', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/balance');
    const reply = sent.join('\n');
    assert.match(reply, /Then reply with your unlock PIN\./);
    assert.doesNotMatch(reply, /password/i);
  });

  it('stays locked for the password, and opens for the PIN', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/balance');
    await router.handle(ctx, '/unlock');
    await router.handle(ctx, PASSWORD);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
    await router.handle(ctx, '/unlock');
    await router.handle(ctx, PIN);
    assert.equal(sessionRow(WITH_PIN).is_locked, false);
    assert.match(sent.join('\n'), /Session unlocked/);
  });

  it('sends an account with no PIN to the site', async () => {
    const { ctx, sent } = await lockedChat(NO_PIN);
    await router.handle(ctx, '/balance');
    await router.handle(ctx, `/unlock ${PASSWORD}`);
    assert.match(sent.join('\n'), SET_PIN);
  });
});

describe('secrets never reach the log', () => {
  async function logged(ctx, message) {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await router.handle(ctx, message);
    } finally {
      console.log = original;
    }
    return lines.join('\n');
  }

  it('hides the claimadmin secret', async () => {
    const out = await logged(ctxFor(WITH_PIN, []), '/claimadmin not-the-real-secret-9f3a');
    assert.doesNotMatch(out, /not-the-real-secret-9f3a/);
    assert.match(out, /cmd=claimadmin <secret hidden>/);
  });

  it('hides a PIN and a password sent to unlock', async () => {
    const { ctx } = await lockedChat(WITH_PIN);
    const oneShot = await logged(ctx, `/unlock ${PASSWORD}`);
    await logged(ctx, '/unlock');
    const reply = await logged(ctx, PIN);
    for (const out of [oneShot, reply]) {
      assert.doesNotMatch(out, new RegExp(`${PIN}|${PASSWORD.replace('!', '\\!')}`));
      assert.match(out, /<secret hidden>/);
    }
  });
});
