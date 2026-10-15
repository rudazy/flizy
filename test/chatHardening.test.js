/**
 * Chat hardening, driven through the router against a fake database:
 *
 * - CONFIRM reads the unlock and the trusted list again, so a plan made while
 *   unlocked cannot be sent after the chat locked or the destination was
 *   removed on the site.
 * - unlink from chat takes a fresh PIN approval on flizy.app, then tells the
 *   owner on every chat that was linked (the removed one included) and by
 *   email.
 * - a link code cannot move a chat off another site account.
 * - a PIN typed into chat is never checked; it is deleted where the channel
 *   allows it, the owner is asked to delete it where it does not, and the
 *   unlock link is sent instead.
 *
 * Run: node --test test/chatHardening.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
const { PIN_HASH_PRESENT, unlockedSession } = require('./helpers/unlockedChat');

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
    unlock_pin_hash: PIN_HASH_PRESENT,
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
    assert.match(sent.join('\n'), /Nothing was sent\.\nChat locked\./);
    assert.equal(router.pendingFlowFor(TG_KEY).send, false);
  });
});

describe('unlink from chat', () => {
  const { pollApprovals } = require('../lib/chatApprovals');
  const approvals = () => tables().chat_approvals || [];

  /** What the approval page does on a right PIN. */
  function approveOnPage() {
    const row = approvals().find((r) => !r.approved_at && !r.cancelled_at);
    assert.ok(row, 'an open approval');
    row.approved_at = new Date().toISOString();
  }

  beforeEach(() => {
    router.discardPendingFlows(TG_KEY);
  });

  it('sends a fresh PIN link, even on an unlocked chat, and removes nothing yet', async () => {
    seed();
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink whatsapp');
    assert.match(sent.join('\n'), /Unlink WhatsApp with your PIN on Flizy: \S+\/a\//);
    assert.equal(identitiesOf(OWNER).length, 2);
    assert.equal(approvals()[0].kind, 'unlink');
    assert.equal(tables().notifications.length, 0);
    assert.deepEqual(mails, []);
  });

  it('works from a locked chat too: the PIN on the page is the proof', async () => {
    seed({ unlocked: false });
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink whatsapp');
    approveOnPage();
    await pollApprovals();
    assert.deepEqual(identitiesOf(OWNER).map((i) => i.channel), ['telegram']);
  });

  it('is refused when the account has no PIN, and points to the site', async () => {
    seed({ pin: false });
    const sent = [];
    await router.handle(ctxFor(sent), '/unlink whatsapp');
    assert.match(sent.join('\n'), /needs an unlock PIN, and this account has none/);
    assert.match(sent.join('\n'), /dashboard\/account\?s=chat/);
    assert.equal(approvals().length, 0);
    assert.equal(identitiesOf(OWNER).length, 2);
  });

  it('removing the other chat tells that chat, and emails the owner', async () => {
    seed();
    await router.handle(ctxFor([]), '/unlink whatsapp');
    approveOnPage();
    await pollApprovals();
    assert.deepEqual(identitiesOf(OWNER).map((i) => i.channel), ['telegram']);

    // The removed WhatsApp is no longer on the account, and still hears it.
    const toWa = tables().notifications.filter((n) => n.channel === 'whatsapp' && n.external_id === WA);
    assert.equal(toWa.length, 1);
    assert.match(toWa[0].body, /WhatsApp was unlinked from your Flizy account, from your Telegram chat\./);
    assert.match(toWa[0].body, /someone has that phone and your PIN/);
    // The chat that asked reads the outcome there.
    const toTg = tables().notifications.filter((n) => n.channel === 'telegram').map((n) => n.body).join('\n');
    assert.match(toTg, /WhatsApp unlinked from Flizy\./);
    assert.deepEqual(mails, [{ accountId: OWNER, kind: 'unlinked' }]);
  });

  it('removing this chat tells the chats still linked, and emails the owner', async () => {
    seed();
    await router.handle(ctxFor([]), '/unlink');
    approveOnPage();
    await pollApprovals();
    assert.deepEqual(identitiesOf(OWNER).map((i) => i.channel), ['whatsapp']);
    const toWa = tables().notifications.filter((n) => n.channel === 'whatsapp');
    assert.equal(toWa.length, 1);
    assert.match(toWa[0].body, /Telegram was unlinked from your Flizy account/);
    const toTg = tables().notifications.filter((n) => n.channel === 'telegram').map((n) => n.body).join('\n');
    assert.match(toTg, /Telegram unlinked from Flizy\./);
    assert.doesNotMatch(toTg, /was unlinked from your Flizy account/);
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

describe('a PIN typed into chat', () => {
  const approvals = () => tables().chat_approvals || [];

  beforeEach(() => {
    seed({ unlocked: false });
    router.discardPendingFlows(TG_KEY);
  });

  it('is never checked: right or wrong, the chat stays locked and gets a link', async () => {
    for (const guess of [PIN, '000000']) {
      seed({ unlocked: false });
      const sent = [];
      await router.handle(ctxFor(sent), `/unlock ${guess}`);
      const text = sent.join('\n');
      assert.match(text, /Flizy never takes your PIN in chat\./);
      assert.match(text, /Unlock this chat with your PIN on Flizy: \S+\/a\//);
      assert.doesNotMatch(text, /unlocked|Wrong PIN/i);
      assert.ok(!text.includes(guess), 'the PIN is never echoed');
      assert.equal(tables().sessions.length, 0, 'nothing was unlocked');
    }
  });

  it('is deleted on Telegram', async () => {
    let deleted = 0;
    const sent = [];
    await router.handle(ctxFor(sent, { forgetMessage: async () => { deleted += 1; } }), `/unlock ${PIN}`);
    assert.equal(deleted, 1);
    assert.doesNotMatch(sent.join('\n'), /Delete your message with the PIN/);
  });

  it('the owner is asked to delete it where the bot cannot, or when deleting fails', async () => {
    for (const forgetMessage of [undefined, async () => { throw new Error('message too old'); }]) {
      seed({ unlocked: false });
      const sent = [];
      await router.handle(ctxFor(sent, { forgetMessage }), `/unlock ${PIN}`);
      assert.match(sent.join('\n'), /Delete your message with the PIN from this chat\./);
    }
  });

  it('a bare unlock carries no PIN, so nothing is deleted, and the link is sent', async () => {
    let deleted = 0;
    const sent = [];
    await router.handle(ctxFor(sent, { forgetMessage: async () => { deleted += 1; } }), '/unlock');
    assert.equal(deleted, 0);
    assert.match(sent.join('\n'), /Unlock this chat with your PIN on Flizy: /);
    assert.equal(approvals()[0].kind, 'unlock');
    assert.match(approvals()[0].chat_label, /^Telegram/);
  });

  it('a new unlock withdraws the link before it, so only one works at a time', async () => {
    await router.handle(ctxFor([]), '/unlock');
    await router.handle(ctxFor([]), '/unlock');
    const rows = approvals();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].cancelled_at, 'the first link is withdrawn');
    assert.equal(rows[1].cancelled_at || null, null);
  });

  it('once the chat is unlocked, a bare number is no longer taken for a PIN', async () => {
    const { pollApprovals } = require('../lib/chatApprovals');
    await router.handle(ctxFor([]), '/unlock');
    approvals()[0].approved_at = new Date().toISOString();
    await pollApprovals();
    assert.equal(router.pendingFlowFor(TG_KEY).unlockLink, false);
  });

  it('the page approving the unlock opens the chat', async () => {
    const { pollApprovals } = require('../lib/chatApprovals');
    await router.handle(ctxFor([]), '/unlock');
    approvals()[0].approved_at = new Date().toISOString();
    await pollApprovals();
    assert.equal(tables().sessions[0].is_locked, false);
    assert.ok(new Date(tables().sessions[0].expires_at).getTime() > Date.now());
    assert.match(tables().notifications.map((n) => n.body).join('\n'), /Telegram unlocked for 30 minutes of activity\./);
  });

  it('is never suggested anywhere', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), `/send 0.001 to ${FRIEND}`);
    assert.match(sent.join('\n'), /Chat locked\. Send \/unlock and enter your PIN on Flizy\./);
    assert.doesNotMatch(sent.join('\n'), /unlock your-pin|reply with your unlock PIN/i);
  });
});
