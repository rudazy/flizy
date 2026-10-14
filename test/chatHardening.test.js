/**
 * Chat hardening, driven through the router against a fake database:
 *
 * - CONFIRM reads the unlock and the trusted list again, so a plan made while
 *   unlocked cannot be sent after the chat locked or the destination was
 *   removed on the site.
 * - unlink from chat needs an unlocked chat, and tells the owner on every chat
 *   that was linked (the removed one included) and by email.
 * - a link code cannot move a chat off another site account.
 * - a message carrying a PIN is deleted where the channel allows it, and the
 *   owner is asked to delete it where it does not.
 *
 * Run: node --test test/chatHardening.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { unlockedSession } = require('./helpers/unlockedChat');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
const { hashPin } = require('../lib/cryptoPin');

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
    provider: {
      getCode: async () => '0x',
      getBalance: async () => 10n ** 18n,
    },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

// Moving money is what must not happen when a recheck fails. Counted here.
let moved = 0;
const realEngine = require('../lib/engine');
const enginePath = require.resolve('../lib/engine');
require.cache[enginePath] = {
  id: enginePath,
  filename: enginePath,
  loaded: true,
  exports: {
    ...realEngine,
    executeNativeSend: async () => {
      moved += 1;
      return { ok: true, txHash: '0xabc', explorerUrl: 'https://explorer.test/tx/0xabc' };
    },
    executeClaimHold: async () => {
      moved += 1;
      return { ok: true, claim: { id: 'claim-1', claim_token: 'tok' }, txHash: '0xabc' };
    },
  },
};

// The email request leaves the process, so it is recorded instead.
const mails = [];
const mailPath = require.resolve('../lib/securityMail');
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: {
    requestSecurityMail: async (accountId, kind) => {
      mails.push({ accountId, kind });
      return 'sent';
    },
  },
};

const router = require('../lib/router');

const PIN = '482915';
const TG = '778899131';
const WA = '2348011112222';
const TG_KEY = `telegram:${TG}`;
const OWNER = 'acc-owner';
const OTHER = 'acc-other';
const FRIEND = '0x5555555555555555555555555555555555555555';

function ctxFor(sent, { channel = 'telegram', externalId = TG, forgetMessage } = {}) {
  return {
    channel,
    externalId,
    key: `${channel}:${externalId}`,
    raw: {},
    reply: async (text) => {
      sent.push(text);
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
    ...(forgetMessage ? { forgetMessage } : {}),
  };
}

function account(id, extra = {}) {
  return {
    id,
    email: `${id}@example.com`,
    display_name: id,
    username: id.replace(/-/g, ''),
    balance_eth: 0,
    is_admin: false,
    agent_wallet_address: id === OWNER ? '0x9999999999999999999999999999999999999999' : '0x8888888888888888888888888888888888888888',
    unlock_pin_hash: hashPin(PIN),
    ...extra,
  };
}

/**
 * The owner has Telegram and WhatsApp linked. Telegram is unlocked unless told
 * otherwise; FRIEND is on the owner's trusted list.
 */
function seed({ unlocked = true, pin = true } = {}) {
  moved = 0;
  mails.length = 0;
  fake = createFakeSupabase({
    accounts: [account(OWNER, pin ? {} : { unlock_pin_hash: null }), account(OTHER)],
    channel_identities: [
      { id: 'i-tg', account_id: OWNER, channel: 'telegram', external_id: TG, phone_e164: null },
      { id: 'i-wa', account_id: OWNER, channel: 'whatsapp', external_id: WA, phone_e164: `+${WA}` },
    ],
    link_codes: [],
    users: [],
    sessions: unlocked ? [unlockedSession(OWNER, 'telegram', TG)] : [],
    trusted_addresses: [
      {
        id: 't1',
        account_id: OWNER,
        address: FRIEND,
        label: 'friend',
        status: 'active',
        active_at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ],
    transfers: [],
    claims: [],
    notifications: [],
    identity_events: [],
    link_code_attempts: [],
  });
}

const tables = () => fake.db.tables;
const identitiesOf = (accountId) => tables().channel_identities.filter((i) => i.account_id === accountId);

describe('CONFIRM rechecks what the plan was allowed on', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(TG_KEY);
  });

  it('sends to a trusted address when nothing changed', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, `/send 0.001 to ${FRIEND}`);
    assert.equal(router.pendingFlowFor(TG_KEY).send, true, `expected a plan, got:\n${sent.join('\n')}`);
    await router.handle(ctx, 'confirm');
    assert.equal(moved, 1, sent.join('\n'));
  });

  it('refuses when the address left the trusted list after the plan was made', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, `/send 0.001 to ${FRIEND}`);
    assert.equal(router.pendingFlowFor(TG_KEY).send, true, `expected a plan, got:\n${sent.join('\n')}`);

    tables().trusted_addresses.length = 0;
    sent.length = 0;
    await router.handle(ctx, 'confirm');
    assert.equal(moved, 0);
    assert.match(sent.join('\n'), /Nothing was sent\.\n/);
    assert.match(sent.join('\n'), /trusted list/);
    assert.equal(router.pendingFlowFor(TG_KEY).send, false);
  });

  it('refuses when the unlock lapsed after the plan was made', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/send 0.001 to 2348099999999');
    assert.equal(router.pendingFlowFor(TG_KEY).send, true, `expected a plan, got:\n${sent.join('\n')}`);

    // A password change on the site does this to every chat.
    tables().sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();
    sent.length = 0;
    await router.handle(ctx, 'confirm');
    assert.equal(moved, 0);
    assert.match(sent.join('\n'), /Nothing was sent\.\nSession locked\./);
    assert.equal(router.pendingFlowFor(TG_KEY).send, false);
  });
});

describe('unlink from chat', () => {
  beforeEach(() => {
    router.discardPendingFlows(TG_KEY);
  });

  it('is refused on a chat that is not unlocked, and nothing is removed', async () => {
    seed({ unlocked: false });
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink whatsapp');
    assert.match(sent.join('\n'), /Unlinking needs an unlocked chat\./);
    assert.equal(identitiesOf(OWNER).length, 2);
    assert.equal(tables().notifications.length, 0);
    assert.deepEqual(mails, []);
  });

  it('is refused when the account has no PIN, and points to the site', async () => {
    seed({ pin: false });
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink whatsapp');
    assert.match(sent.join('\n'), /needs an unlock PIN, and this account has none/);
    assert.match(sent.join('\n'), /dashboard\/account\?s=chat/);
    assert.equal(identitiesOf(OWNER).length, 2);
  });

  it('removing the other chat tells that chat, and emails the owner', async () => {
    seed();
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink whatsapp');
    assert.match(sent.join('\n'), /WhatsApp unlinked from Flizy\./);
    assert.deepEqual(identitiesOf(OWNER).map((i) => i.channel), ['telegram']);

    // The removed WhatsApp is no longer on the account, and still hears it.
    const toWa = tables().notifications.filter((n) => n.channel === 'whatsapp' && n.external_id === WA);
    assert.equal(toWa.length, 1);
    assert.match(toWa[0].body, /WhatsApp was unlinked from your Flizy account, from your Telegram chat\./);
    assert.match(toWa[0].body, /someone has that phone and your PIN/);
    assert.deepEqual(mails, [{ accountId: OWNER, kind: 'unlinked' }]);
  });

  it('removing this chat tells the chats still linked, and emails the owner', async () => {
    seed();
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink');
    assert.match(sent.join('\n'), /Telegram unlinked from Flizy\./);
    assert.deepEqual(identitiesOf(OWNER).map((i) => i.channel), ['whatsapp']);
    const toWa = tables().notifications.filter((n) => n.channel === 'whatsapp');
    assert.equal(toWa.length, 1);
    assert.match(toWa[0].body, /Telegram was unlinked from your Flizy account/);
    assert.equal(tables().notifications.filter((n) => n.channel === 'telegram').length, 0);
    assert.deepEqual(mails, [{ accountId: OWNER, kind: 'unlinked' }]);
  });
});

describe('a link code cannot move a chat off another site account', () => {
  const CODE = 'ABCDEFGHJK';

  function codeFor(accountId) {
    tables().link_codes.push({
      id: 'lc1',
      account_id: accountId,
      code: CODE,
      used_at: null,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
  }

  beforeEach(() => {
    seed();
    router.discardPendingFlows(TG_KEY);
  });

  it('refuses, leaves the chat and the code where they were, and warns the account it is on', async () => {
    codeFor(OTHER);
    const sent = [];
    await router.handle(ctxFor(sent), `/link ${CODE}`);
    assert.match(sent.join('\n'), /Not linked\.\nThis Telegram is already linked to a different Flizy account\./);
    assert.equal(tables().channel_identities.find((i) => i.external_id === TG).account_id, OWNER);
    assert.equal(tables().link_codes[0].used_at, null, 'the code is not spent');
    assert.equal(tables().link_code_attempts.length, 1, 'counted on the lockout ladder');

    const warned = tables().notifications.filter((n) => n.channel === 'whatsapp' && n.external_id === WA);
    assert.equal(warned.length, 1);
    assert.match(warned[0].body, /Someone tried to move your Telegram to another Flizy account/);
    assert.deepEqual(mails, []);
  });

  it('a retried refusal locks out before it can flood the owner with warnings', async () => {
    codeFor(OTHER);
    for (let i = 0; i < 8; i += 1) {
      await router.handle(ctxFor([]), `/link ${CODE}`);
    }
    const warned = tables().notifications.filter((n) => n.channel === 'whatsapp' && n.external_id === WA);
    assert.ok(warned.length >= 1 && warned.length < 8, `warned ${warned.length} times`);
    assert.equal(tables().channel_identities.find((i) => i.external_id === TG).account_id, OWNER);
  });

  it('still moves a chat whose only account is the one chat made for it', async () => {
    tables().accounts.push({ id: 'acc-chat-only', email: null, unlock_pin_hash: null, balance_eth: 0 });
    tables().channel_identities.find((i) => i.external_id === TG).account_id = 'acc-chat-only';
    codeFor(OTHER);
    const sent = [];
    await router.handle(ctxFor(sent), `/link ${CODE}`);
    assert.match(sent.join('\n'), /Telegram connected to Flizy\./);
    assert.doesNotMatch(sent.join('\n'), /moved from another account/);
    assert.equal(tables().channel_identities.find((i) => i.external_id === TG).account_id, OTHER);
    assert.deepEqual(mails, [{ accountId: OTHER, kind: 'linked' }]);
  });
});

describe('a message carrying a PIN', () => {
  beforeEach(() => {
    seed({ unlocked: false });
    router.discardPendingFlows(TG_KEY);
  });

  it('is deleted on Telegram, right or wrong', async () => {
    for (const guess of [PIN, '000000']) {
      router.discardPendingFlows(TG_KEY);
      let deleted = 0;
      const sent = [];
      const ctx = ctxFor(sent, { forgetMessage: async () => { deleted += 1; } });
      await router.handle(ctx, '/unlock');
      assert.equal(deleted, 0, 'the bare command carries no PIN');
      await router.handle(ctx, guess);
      assert.equal(deleted, 1, guess);
      assert.doesNotMatch(sent.join('\n'), /Delete your message with the PIN/);
    }
  });

  it('is deleted when it rides in the one-line form too', async () => {
    let deleted = 0;
    const sent = [];
    await router.handle(ctxFor(sent, { forgetMessage: async () => { deleted += 1; } }), `/unlock ${PIN}`);
    assert.equal(deleted, 1);
    assert.match(sent.join('\n'), /Session unlocked/);
  });

  it('asks the owner to delete it where the bot cannot', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/unlock');
    await router.handle(ctx, PIN);
    assert.match(sent.join('\n'), /Session unlocked[\s\S]*\n\nDelete your message with the PIN from this chat\.$/);
  });

  it('still unlocks when the delete fails, and falls back to asking', async () => {
    const sent = [];
    const ctx = ctxFor(sent, { forgetMessage: async () => { throw new Error('message too old'); } });
    await router.handle(ctx, `/unlock ${PIN}`);
    assert.match(sent.join('\n'), /Session unlocked/);
    assert.match(sent.join('\n'), /Delete your message with the PIN from this chat\./);
  });

  it('is never suggested in the one-line form', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), `/send 0.001 to ${FRIEND}`);
    assert.match(sent.join('\n'), /Session locked\. Send: \/unlock\nThen reply with your unlock PIN\./);
    assert.doesNotMatch(sent.join('\n'), /unlock your-pin/);
  });
});
