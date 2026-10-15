/**
 * Chat takes no secret at all: not the account password, and not the PIN.
 *
 * A chat message stays in the chat history, on the phone and on the chat
 * provider's servers. The PIN is typed on a flizy.app approval page instead
 * (lib/chatApprovals.js). In chat, unlock answers with a link, a secret typed
 * anyway (with the command, or on its own right after the link) is refused
 * without being checked, and an account with no PIN is sent to the site to set
 * one. The trade flow is covered in test/tradeSecret.test.js. This file also
 * checks that no secret-carrying message reaches the log.
 *
 * Run: node --test test/chatPinOnly.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
// Chat never checks a PIN or a password, so a stored value only has to exist.
const { PIN_HASH_PRESENT } = require('./helpers/unlockedChat');
const PASSWORD_HASH_PRESENT = 'password-hash-present';

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
    unlock_pin_hash: pin ? PIN_HASH_PRESENT : null,
    password_hash: PASSWORD_HASH_PRESENT,
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

describe('unlock is a link, whatever is typed', () => {
  it('a bare unlock sends the PIN link and unlocks nothing', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/unlock');
    assert.match(sent.join('\n'), /Unlock this chat with your PIN on Flizy: \S+\/a\//);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
  });

  it('the account password typed in chat is refused, even when it is right', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, `/unlock ${PASSWORD}`);
    assert.match(sent.join('\n'), /Flizy never takes your PIN in chat\./);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
  });

  it('the right PIN typed in chat is refused too, and never confirmed as right', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, `/unlock ${PIN}`);
    const text = sent.join('\n');
    assert.match(text, /Flizy never takes your PIN in chat\./);
    assert.doesNotMatch(text, /unlocked/i);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
  });

  it('a PIN sent on its own right after the link is refused the same way', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/unlock');
    sent.length = 0;
    await router.handle(ctx, PIN);
    assert.match(sent.join('\n'), /Flizy never takes your PIN in chat\./);
    assert.equal(sessionRow(WITH_PIN).is_locked, true);
  });

  it('sends an account with no PIN to the site', async () => {
    const { ctx, sent } = await lockedChat(NO_PIN);
    await router.handle(ctx, '/unlock');
    assert.match(sent.join('\n'), SET_PIN);
  });

  it('the hard-lock gate points at the link, not at a PIN in chat', async () => {
    const { ctx, sent } = await lockedChat(WITH_PIN);
    await router.handle(ctx, '/balance');
    assert.match(sent.join('\n'), /Chat locked\. Send \/unlock and enter your PIN on Flizy\./);
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

  it('hides the retired claimadmin secret', async () => {
    const out = await logged(ctxFor(WITH_PIN, []), '/claimadmin not-the-real-secret-9f3a');
    assert.doesNotMatch(out, /not-the-real-secret-9f3a/);
    assert.match(out, /cmd=claimadmin <secret hidden>/);
  });

  it('hides a PIN or a password typed into chat, with the command or on its own', async () => {
    const { ctx } = await lockedChat(WITH_PIN);
    const withCommand = await logged(ctx, `/unlock ${PASSWORD}`);
    await logged(ctx, '/unlock');
    const onItsOwn = await logged(ctx, PIN);
    for (const out of [withCommand, onItsOwn]) {
      assert.doesNotMatch(out, new RegExp(`${PIN}|${PASSWORD.replace('!', '\\!')}`));
      assert.match(out, /<secret hidden>/);
    }
  });
});
