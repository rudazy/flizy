/**
 * Telegram adapter surface: how raw Telegram text becomes a router command,
 * and how a shared contact is accepted or refused.
 *
 * Run: node --test test/telegramRouter.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

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
    supabase: { from: (table) => fake.client.from(table) },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const { splitMessage, inlineKeyboard, requestContactKeyboard } = require('../lib/telegram/api');
const { TelegramApi } = require('../lib/telegram/api');

const TG_ID = '778899123';

function telegramCtx(sent = []) {
  return {
    channel: 'telegram',
    externalId: TG_ID,
    key: `telegram:${TG_ID}`,
    raw: {},
    reply: async (text, opts) => {
      sent.push({ text, opts });
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async (text) => {
      sent.push({ text, phoneRequest: true });
    },
  };
}

function whatsappCtx(sent = []) {
  return {
    channel: 'whatsapp',
    externalId: '2348012345678',
    key: 'whatsapp:2348012345678',
    raw: {},
    reply: async (text) => {
      sent.push({ text });
    },
    resolveVerifiedPhone: async () => null,
  };
}

describe('Telegram input normalization', () => {
  const ctx = telegramCtx();

  it('turns a slash command into a plain command body', () => {
    assert.equal(router.normalizeInput(ctx, '/balance').text, 'balance');
    assert.equal(router.normalizeInput(ctx, '/send 0.01 to john').text, 'send 0.01 to john');
  });

  it('strips the @botname suffix Telegram adds in some clients', () => {
    assert.equal(router.normalizeInput(ctx, '/send@FlizyBot 0.01 to john').text, 'send 0.01 to john');
    assert.equal(router.normalizeInput(ctx, '/help@FlizyBot').text, 'help');
  });

  it('maps the deep link /start CODE onto the link command', () => {
    assert.equal(router.normalizeInput(ctx, '/start A7K2QX99').text, 'link A7K2QX99');
    const parsed = router.parseLinkCommand(router.normalizeInput(ctx, '/start A7K2QX99').text);
    assert.equal(parsed.code, 'A7K2QX99');
  });

  it('treats a bare /start as help', () => {
    assert.equal(router.normalizeInput(ctx, '/start').text, 'help');
  });

  it('accepts bare commands and the flizy prefix alike', () => {
    assert.equal(router.normalizeInput(ctx, 'balance').text, 'balance');
    assert.equal(router.normalizeInput(ctx, 'flizy balance').text, 'balance');
  });

  it('accepts typed confirm and cancel so buttons are never required', () => {
    assert.equal(router.normalizeInput(ctx, 'Confirm').text, 'confirm');
    assert.equal(router.normalizeInput(ctx, 'CANCEL').text, 'cancel');
  });

  it('ignores chatter that is not a command', () => {
    assert.equal(router.normalizeInput(ctx, 'hey there'), null);
  });
});

/**
 * Telegram is slash native. Every command the bot advertises in its menu has to
 * work when typed or tapped as "/command", with no "flizy" in front of it. If a
 * command is added to the menu without a parser behind it, this fails.
 */
describe('every advertised Telegram command works as a bare slash command', () => {
  const ctx = telegramCtx();

  /** Sample arguments for the commands that take them. */
  const ARGS = {
    link: 'A7K2QX99',
    send: '0.01 to john',
    request: '0.01 from 2348012345678',
    buy: '0.01 FLZ',
    sell: '10 FLZ',
    swap: '0.01 ETH for FLZ',
    price: 'FLZ',
  };

  for (const { command } of router.commandMenu()) {
    const body = `${command}${ARGS[command] ? ` ${ARGS[command]}` : ''}`;
    it(`/${body}`, () => {
      const normalized = router.normalizeInput(ctx, `/${body}`);
      assert.ok(normalized, `/${body} was ignored`);
      assert.equal(normalized.text, body, 'slash must be stripped, nothing else changed');
      assert.equal(
        router.isFlizyCommandBody(normalized.text),
        true,
        `/${body} is advertised but no parser recognises it`
      );
    });
  }

  it('needs no flizy prefix for any of them', () => {
    for (const { command } of router.commandMenu()) {
      assert.ok(router.isFlizyCommand(ctx, `/${command}`), `/${command} should wake the bot`);
    }
  });

  it('also accepts commands that are not in the menu', () => {
    for (const body of ['how', 'requests', 'cancel claims', 'contacts']) {
      assert.equal(router.normalizeInput(ctx, `/${body}`).text, body);
    }
  });
});

describe('WhatsApp input normalization is unchanged', () => {
  const ctx = whatsappCtx();

  it('requires the flizy prefix for ordinary commands', () => {
    assert.equal(router.normalizeInput(ctx, 'balance'), null);
    assert.equal(router.normalizeInput(ctx, 'flizy balance').text, 'balance');
  });

  it('still lets bare confirm and cancel through', () => {
    assert.equal(router.normalizeInput(ctx, 'confirm').text, 'confirm');
    assert.equal(router.normalizeInput(ctx, 'cancel').text, 'cancel');
  });

  it('treats a bare flizy as help', () => {
    assert.equal(router.normalizeInput(ctx, 'flizy').text, 'help');
  });

  it('does not wake on a greeting', () => {
    assert.equal(router.isFlizyCommand(ctx, 'hello'), false);
    assert.equal(router.isFlizyCommand(ctx, 'flizy help'), true);
  });
});

describe('command rendering per channel', () => {
  it('shows slash commands on Telegram and the prefix on WhatsApp', () => {
    assert.equal(router.cmd(telegramCtx(), 'send 0.01 to john'), '/send 0.01 to john');
    assert.equal(router.cmd(whatsappCtx(), 'send 0.01 to john'), 'flizy send 0.01 to john');
  });

  it('publishes a command menu that covers the money paths', () => {
    const names = router.commandMenu().map((c) => c.command);
    for (const expected of ['link', 'me', 'balance', 'send', 'claim', 'pay', 'lock', 'unlock']) {
      assert.ok(names.includes(expected), `missing /${expected}`);
    }
    // Telegram rejects commands outside this shape
    for (const c of router.commandMenu()) {
      assert.match(c.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(c.description.length > 0 && c.description.length <= 256);
    }
  });
});

describe('shared contact is the only phone Flizy trusts', () => {
  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [{ id: 'acc-a', email: 'a@example.com', balance_eth: 0, is_admin: false }],
      channel_identities: [
        {
          id: 'i1',
          account_id: 'acc-a',
          channel: 'telegram',
          external_id: TG_ID,
          phone_e164: null,
        },
      ],
    });
  });

  it('refuses an unverified contact card', async () => {
    const sent = [];
    await router.handleSharedPhone(telegramCtx(sent), {
      phone: '2348012345678',
      verified: false,
    });
    assert.match(sent[0].text, /Share number button|not accepted/i);
    assert.equal(fake.db.tables.channel_identities[0].phone_e164, null);
  });

  it('stores a verified contact and confirms it', async () => {
    const sent = [];
    await router.handleSharedPhone(telegramCtx(sent), {
      phone: '+234 801 234 5678',
      verified: true,
    });
    assert.equal(fake.db.tables.channel_identities[0].phone_e164, '2348012345678');
    assert.match(sent[0].text, /Number verified/i);
  });

  it('refuses a number already bound to a different account', async () => {
    fake.db.tables.accounts.push({ id: 'acc-b', email: 'b@example.com' });
    fake.db.tables.channel_identities.push({
      id: 'i2',
      account_id: 'acc-b',
      channel: 'whatsapp',
      external_id: '216123456789017',
      phone_e164: '2348012345678',
    });

    const sent = [];
    await router.handleSharedPhone(telegramCtx(sent), {
      phone: '2348012345678',
      verified: true,
    });

    assert.match(sent[0].text, /already on a different Flizy account/i);
    assert.equal(fake.db.tables.channel_identities[0].phone_e164, null);
  });

  it('asks the user to link before it will store a number', async () => {
    fake.db.tables.channel_identities = [];
    const sent = [];
    await router.handleSharedPhone(telegramCtx(sent), {
      phone: '2348012345678',
      verified: true,
    });
    assert.match(sent[0].text, /Link your Flizy account first/i);
  });
});

describe('end to end through the shared router', () => {
  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [
        {
          id: 'acc-a',
          email: 'a@example.com',
          display_name: 'A',
          balance_eth: 0,
          is_admin: false,
          agent_wallet_address: null,
          unlock_pin_hash: null,
        },
      ],
      channel_identities: [],
      link_codes: [],
      users: [],
    });
  });

  it('welcomes a first-time user once, then answers /help in Telegram style', async () => {
    const first = [];
    await router.handle(telegramCtx(first), '/help');
    const welcome = first.map((s) => s.text).join('\n');
    assert.match(welcome, /Welcome to Flizy/);
    assert.match(welcome, /\/send 0\.001 to ama/);
    // A first message of /help must still answer the question it asked: the
    // greeting on its own left a new user with no command list.
    assert.match(welcome, /\/send 0\.01 to john/, 'first /help must include the command list');

    // Second time the user is known, so the full command list comes through
    const second = [];
    await router.handle(telegramCtx(second), '/help');
    const help = second.map((s) => s.text).join('\n');
    assert.ok(!/Welcome to Flizy/.test(help));
    assert.match(help, /\/send 0\.01 to john/);
    assert.ok(!/flizy send 0\.01 to john/.test(help));
  });

  it('links through the /start CODE deep link and then asks for the number', async () => {
    fake.db.tables.link_codes.push({
      id: 'code-1',
      account_id: 'acc-a',
      code: 'A7K2QX99',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
    });

    const sent = [];
    await router.handle(telegramCtx(sent), '/start A7K2QX99');

    const bound = fake.db.tables.channel_identities[0];
    assert.equal(bound.account_id, 'acc-a');
    assert.equal(bound.channel, 'telegram');
    assert.equal(bound.external_id, TG_ID);
    assert.ok(fake.db.tables.link_codes[0].used_at);

    const joined = sent.map((s) => s.text).join('\n');
    assert.match(joined, /Telegram connected to Flizy/);
    assert.ok(sent.some((s) => s.phoneRequest), 'should prompt for the contact share');
  });

  it('tells an unlinked user to link before it will run a money command', async () => {
    const sent = [];
    await router.handle(telegramCtx(sent), '/send 0.01 to john');
    assert.match(sent.map((s) => s.text).join('\n'), /Link your site account first/);
  });

  it('says nothing useful is happening for chatter, without echoing it back', async () => {
    const sent = [];
    await router.handle(telegramCtx(sent), 'my password is hunter2');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Not a Flizy command/);
    assert.ok(!sent[0].text.includes('hunter2'));
  });
});

describe('a Telegram user id is never treated as a phone', () => {
  const { claimMatchKeys } = require('../lib/phone');

  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [{ id: 'acc-a', email: 'a@example.com' }],
      channel_identities: [],
    });
  });

  it('yields no claim key when the Telegram user has not shared a number', async () => {
    // A phone-length Telegram id must not become a claim address
    const bigId = '2348012345678';
    fake.db.tables.channel_identities.push({
      id: 'i1',
      account_id: 'acc-a',
      channel: 'telegram',
      external_id: bigId,
      phone_e164: null,
    });

    const ctx = telegramCtx();
    ctx.externalId = bigId;
    ctx.key = `telegram:${bigId}`;

    const identity = await router.resolveClaimIdentity(ctx);
    assert.equal(identity.waSenderId, '');
    assert.equal(identity.waPhone, null);
    assert.deepEqual(claimMatchKeys(identity), []);
  });

  it('uses the shared number once it exists', async () => {
    fake.db.tables.channel_identities.push({
      id: 'i1',
      account_id: 'acc-a',
      channel: 'telegram',
      external_id: TG_ID,
      phone_e164: '2348012345678',
    });

    const identity = await router.resolveClaimIdentity(telegramCtx());
    assert.equal(identity.waPhone, '2348012345678');
    assert.deepEqual(claimMatchKeys(identity), ['2348012345678']);
  });

  it('keeps the legacy WhatsApp sender id as a claim key', async () => {
    fake.db.tables.channel_identities.push({
      id: 'i1',
      account_id: 'acc-a',
      channel: 'whatsapp',
      external_id: '2348012345678',
      phone_e164: null,
    });

    const identity = await router.resolveClaimIdentity(whatsappCtx());
    assert.equal(identity.waSenderId, '2348012345678');
    assert.deepEqual(claimMatchKeys(identity), ['2348012345678']);
  });
});

describe('Telegram API helpers', () => {
  it('rejects a missing or malformed bot token', () => {
    assert.throws(() => new TelegramApi(''), /TELEGRAM_BOT_TOKEN is missing/);
    assert.throws(() => new TelegramApi('not-a-token'), /does not look like/);
  });

  it('never exposes the token on the instance surface', () => {
    const api = new TelegramApi('123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn');
    assert.equal(Object.keys(api).includes('token'), false);
    assert.equal(JSON.stringify(api).includes('AAaaBB'), false);
    assert.equal(api.scrub('failed for bot123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn/x'),
      'failed for bot<token>/x');
  });

  it('splits long messages on line boundaries', () => {
    const line = 'x'.repeat(200);
    const text = Array.from({ length: 40 }, () => line).join('\n');
    const chunks = splitMessage(text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 4096);
    }
    assert.equal(chunks.join('\n'), text);
  });

  it('maps router buttons onto an inline keyboard', () => {
    const markup = inlineKeyboard([
      [
        { label: 'Confirm', value: 'confirm' },
        { label: 'Cancel', value: 'cancel' },
      ],
    ]);
    assert.deepEqual(markup.inline_keyboard[0][0], { text: 'Confirm', callback_data: 'confirm' });
  });

  it('builds a contact-share keyboard, not a text prompt', () => {
    const markup = requestContactKeyboard();
    assert.equal(markup.keyboard[0][0].request_contact, true);
  });
});
