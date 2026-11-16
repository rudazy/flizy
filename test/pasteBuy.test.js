/**
 * Paste-first buy: send a contract address, get told what it is, then decide.
 *
 * The gesture is the same as pasting a pay code. The trust properties are not,
 * and that is what most of this file is about.
 *
 * A pay code resolves to a name Flizy issued, so nobody else can put a name
 * behind it. A token's ticker is whatever its deployer typed, and market cap is
 * trivially inflated by whoever made the token. So the two branches that matter
 * here are the ones that refuse: a pasted wallet must never open a buy, and a
 * token with no pool must say so rather than quote against nothing.
 *
 * The question under a token offers quick amounts (lib/buyAmounts.js):
 * buttons on Telegram, a list on WhatsApp, editable per account. A button only
 * answers the token it was made for, and a pick is the same as typing it.
 *
 * Run: node --test test/pasteBuy.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

/** What the chain says is at the pasted address. Set per test. */
let codeAt = '0x';
/** What getTokenOverview returns. Set per test. */
let overview = null;

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
    provider: { getCode: async () => codeAt },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

// Only getTokenOverview is stubbed. Everything else in the dex layer stays
// real, so a change to resolveToken or the fee maths still shows up here.
const realDex = require('../lib/dex');
const dexPath = require.resolve('../lib/dex');
require.cache[dexPath] = {
  id: dexPath,
  filename: dexPath,
  loaded: true,
  exports: {
    ...realDex,
    getTokenOverview: async () => {
      if (!overview) throw new Error('not a token');
      return overview;
    },
  },
};

const router = require('../lib/router');
const { parseBareContract, isFlizyCommandBody } = require('../lib/commands/parse');

const TG = '778899125';
const KEY = `telegram:${TG}`;
const TOKEN = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const WALLET = '0x1111111111111111111111111111111111111111';

function ctxFor(sent) {
  return {
    channel: 'telegram',
    externalId: TG,
    key: KEY,
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
        id: 'acc-buyer',
        email: 'buyer@example.com',
        display_name: 'Buyer',
        username: 'buyer',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x9999999999999999999999999999999999999999',
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-buyer', channel: 'telegram', external_id: TG, phone_e164: null },
    ],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
  });
}

function withPool(extra = {}) {
  return {
    address: TOKEN,
    symbol: 'MOON',
    decimals: 18,
    totalSupply: 1000000n,
    pool: '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227',
    liquidityEthWei: 10n ** 18n,
    priceEthPerToken: 0.001,
    marketCapEth: 1000,
    isListed: false,
    ...extra,
  };
}

describe('a contract address pasted on its own', () => {
  it('is recognised, and checksummed on the way through', () => {
    assert.deepEqual(parseBareContract(TOKEN), { address: TOKEN });
    assert.deepEqual(parseBareContract(TOKEN.toLowerCase()), { address: TOKEN });
  });

  it('refuses anything that is not exactly an address', () => {
    for (const t of ['0x123', `add ${TOKEN}`, `${TOKEN} now`, '622412799', '']) {
      assert.equal(parseBareContract(t), null, `${JSON.stringify(t)} should not parse`);
    }
  });

  it('wakes the bot', () => {
    assert.equal(isFlizyCommandBody(TOKEN), true);
  });
});

describe('what the paste answers with', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(KEY);
    codeAt = '0x';
    overview = null;
  });

  it('refuses a wallet address instead of opening a buy', async () => {
    // The safety branch. Someone pasting a friend's address means to pay a
    // person, and code at the address is the only reliable way to tell.
    codeAt = '0x';
    const sent = [];
    await router.handle(ctxFor(sent), WALLET);
    assert.match(sent.join('\n'), /wallet address, not a token contract/i);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, false, 'no buy should be open');
  });

  it('says there is nothing to buy from when the token has no pool', async () => {
    // Pool existence is the strongest signal available: no pool means the quote
    // is impossible, which is more useful than any number on this screen.
    codeAt = '0x60806040';
    overview = withPool({ pool: null, liquidityEthWei: null, marketCapEth: null });
    const sent = [];
    await router.handle(ctxFor(sent), TOKEN);
    const out = sent.join('\n');
    assert.match(out, /No pool for this token/i);
    assert.match(out, /nothing to buy it from/i);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, false, 'nothing to answer');
  });

  it('asks for an amount, and says plainly that it has not vetted the token', async () => {
    codeAt = '0x60806040';
    overview = withPool();
    const sent = [];
    await router.handle(ctxFor(sent), TOKEN);
    const out = sent.join('\n');
    assert.match(out, /MOON/);
    assert.match(out, /Liquidity/);
    assert.match(out, /has not reviewed this token\. You can still buy it/);
    assert.match(out, /Buy MOON with ETH\./);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, true);
  });

  it('does not disclaim a token Flizy actually lists', async () => {
    // The unlisted line has to mean something. If it appears on FLZ too it is
    // wallpaper by the tenth time anyone sees it.
    codeAt = '0x60806040';
    overview = withPool({ symbol: 'FLZ', isListed: true });
    const sent = [];
    await router.handle(ctxFor(sent), TOKEN);
    assert.equal(/has not reviewed/.test(sent.join('\n')), false);
  });

  it('says so when the contract does not answer as a token', async () => {
    codeAt = '0x60806040';
    overview = null; // the stub throws
    const sent = [];
    await router.handle(ctxFor(sent), TOKEN);
    assert.match(sent.join('\n'), /does not answer as a token/i);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, false);
  });
});

describe('the amount step', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(KEY);
    codeAt = '0x60806040';
    overview = withPool();
  });

  it('lets a bare ETH amount through the gate', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, TOKEN);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, true);

    for (const reply of ['0.01', '0.5']) {
      const normalized = router.normalizeInput(ctx, reply);
      assert.notEqual(normalized, null, `"${reply}" must reach the handler`);
    }
  });

  it('is closed by cancel, and says nothing was bought', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, TOKEN);

    sent.length = 0;
    await router.handle(ctx, 'cancel');
    assert.match(sent.join('\n'), /Nothing was bought/i);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, false);
  });

  it('re-targets when a second contract is pasted', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, TOKEN);

    overview = withPool({ symbol: 'OTHER' });
    sent.length = 0;
    await router.handle(ctx, '0x2222222222222222222222222222222222222222');
    assert.match(sent.join('\n'), /OTHER/);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, true);
  });
});

const buyAmounts = require('../lib/buyAmounts');
const { TelegramBot } = require('../lib/telegram/bot');

const WA = '2348011112222';
const WA_KEY = `whatsapp:${WA}`;
const TAG = TOKEN.toLowerCase().slice(-8);

/** A ctx that keeps each reply with its options, for the buttons. */
function recordingCtx(channel = 'telegram') {
  const sent = [];
  const tg = channel === 'telegram';
  return {
    sent,
    ctx: {
      channel,
      externalId: tg ? TG : WA,
      key: tg ? KEY : WA_KEY,
      raw: {},
      reply: async (text, opts) => {
        sent.push({ text, opts });
      },
      resolveVerifiedPhone: async () => null,
      requestPhone: async () => {},
    },
  };
}
const lastText = (sent) => sent[sent.length - 1].text;
const lastButtons = (sent) => sent[sent.length - 1].opts && sent[sent.length - 1].opts.buttons;
const account = () => fake.db.tables.accounts.find((a) => a.id === 'acc-buyer');

describe('quick buy amounts', () => {
  beforeEach(() => {
    seed();
    fake.db.tables.channel_identities.push({ id: 'i2', account_id: 'acc-buyer', channel: 'whatsapp', external_id: WA, phone_e164: `+${WA}` });
    router.discardPendingFlows(KEY);
    router.discardPendingFlows(WA_KEY);
    codeAt = '0x60806040';
    overview = withPool();
  });

  it('Telegram: the default amounts as buttons, then Edit, then Cancel', async () => {
    const { sent, ctx } = recordingCtx();
    await router.handle(ctx, TOKEN);
    assert.match(lastText(sent), /Buy MOON with ETH\.\nTap an amount, or type your own\.$/);
    assert.deepEqual(lastButtons(sent), [
      [
        { label: '0.005 ETH', value: `buy:0.005:${TAG}` },
        { label: '0.01 ETH', value: `buy:0.01:${TAG}` },
        { label: '0.05 ETH', value: `buy:0.05:${TAG}` },
      ],
      [
        { label: '0.1 ETH', value: `buy:0.1:${TAG}` },
        { label: '1 ETH', value: `buy:1:${TAG}` },
        { label: 'Edit', value: `buy:edit:${TAG}` },
      ],
      [{ label: 'Cancel', value: 'cancel' }],
    ]);
    for (const row of lastButtons(sent)) for (const b of row) assert.equal(TelegramBot.isAllowedCallback(b.value), true, b.value);
  });

  it('WhatsApp: the same amounts as a list, with edit and cancel, and no buttons', async () => {
    const { sent, ctx } = recordingCtx('whatsapp');
    await router.handle(ctx, TOKEN);
    assert.match(lastText(sent), /Buy MOON with ETH\. Reply with an amount:\n0\.005 \| 0\.01 \| 0\.05 \| 0\.1 \| 1\nOr type your own\. To change these: edit\nOr: cancel$/);
    assert.equal(lastButtons(sent), undefined);
  });

  it('a pressed amount does exactly what typing it does', async () => {
    const pressed = recordingCtx();
    await router.handle(pressed.ctx, TOKEN);
    await router.handle(pressed.ctx, `buy:0.05:${TAG}`);
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, false);
    const typed = recordingCtx();
    await router.handle(typed.ctx, TOKEN);
    await router.handle(typed.ctx, '0.05');
    assert.equal(lastText(pressed.sent), lastText(typed.sent));
    // Both reached the swap path, whose first gate stops this test account
    // (no unlock PIN) before any quote.
    assert.match(lastText(pressed.sent), /until your account has an unlock PIN/);
  });

  it('a button with no buy open, or from another token, has expired and buys nothing', async () => {
    const { sent, ctx } = recordingCtx();
    await router.handle(ctx, `buy:0.05:${TAG}`);
    assert.equal(lastText(sent), 'That button has expired. Paste the contract again.');
    await router.handle(ctx, TOKEN);
    await router.handle(ctx, 'buy:0.05:0badc0de');
    assert.equal(lastText(sent), 'That button has expired. Paste the contract again.');
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, true, 'the open buy stays open');
  });

  it('Edit, then a list: saved to the account, sorted, and offered from then on', async () => {
    const { sent, ctx } = recordingCtx();
    await router.handle(ctx, TOKEN);
    await router.handle(ctx, `buy:edit:${TAG}`);
    assert.match(lastText(sent), /^Send up to 5 amounts in ETH, separated by spaces\./);
    await router.handle(ctx, '0.2 0.02');
    assert.deepEqual(account().buy_amounts_eth, ['0.02', '0.2']);
    assert.match(lastText(sent), /^Saved\.\n\nBuy MOON with ETH\./);
    assert.deepEqual(lastButtons(sent)[0].map((b) => b.label), ['0.02 ETH', '0.2 ETH', 'Edit']);
    // Still the same buy: an amount buys it.
    assert.equal(router.pendingFlowFor(KEY).tokenBuy, true);
    // The next paste, on either channel, offers them.
    const wa = recordingCtx('whatsapp');
    await router.handle(wa.ctx, TOKEN);
    assert.match(lastText(wa.sent), /\n0\.02 \| 0\.2\n/);
  });

  it('WhatsApp: edit, a list that does not read is refused and the question stays, reset goes back to the defaults', async () => {
    account().buy_amounts_eth = ['0.3'];
    const { sent, ctx } = recordingCtx('whatsapp');
    await router.handle(ctx, TOKEN);
    assert.notEqual(router.normalizeInput(ctx, 'edit'), null);
    await router.handle(ctx, 'edit');
    for (const body of ['reset', '0.01 500', '0.01, 0.05 eth']) assert.notEqual(router.normalizeInput(ctx, body), null, body);
    // Chatter is not a list.
    assert.equal(router.normalizeInput(ctx, 'ok thanks'), null);
    await router.handle(ctx, '0.01 500');
    assert.match(lastText(sent), /^Each amount can be at most 100 ETH\.\nOr: cancel$/);
    assert.deepEqual(account().buy_amounts_eth, ['0.3']);
    await router.handle(ctx, 'reset');
    assert.equal(account().buy_amounts_eth, null);
    assert.match(lastText(sent), /^Back to the default amounts\.\n\nBuy MOON with ETH\. Reply with an amount:\n0\.005 \| 0\.01/);
  });

  it('WhatsApp: a list wakes the bot only after edit', async () => {
    const { ctx } = recordingCtx('whatsapp');
    await router.handle(ctx, TOKEN);
    assert.equal(router.normalizeInput(ctx, 'reset'), null);
    assert.equal(router.normalizeInput(ctx, '0.01 0.05'), null);
  });

  it('a save that fails leaves the amounts as they were, and says so', async () => {
    const { sent, ctx } = recordingCtx();
    await router.handle(ctx, TOKEN);
    await router.handle(ctx, 'edit');
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = (t) => {
      const q = realFrom(t);
      if (t === 'accounts') q.update = () => ({ eq: () => ({ select: async () => ({ data: null, error: { message: 'column does not exist' } }) }) });
      return q;
    };
    try {
      await router.handle(ctx, '0.02');
    } finally {
      fake.client.from = realFrom;
    }
    assert.match(lastText(sent), /^Could not save them right now, so your amounts are unchanged\./);
    assert.deepEqual(lastButtons(sent)[0].map((b) => b.label), ['0.005 ETH', '0.01 ETH', '0.05 ETH']);
  });
});

describe('quick buy amounts, the rules', () => {
  it('reads a list: spaces or commas, a trailing eth, ".5", duplicates dropped, sorted', () => {
    assert.deepEqual(buyAmounts.parseBuyAmounts('1, 0.05 .5 0.050 eth'), { ok: true, amounts: ['0.05', '0.5', '1'] });
  });

  it('refuses none, more than 5, zero, over 100 ETH, more than 6 decimals, or words', () => {
    const refused = { '': /at least one/, '1 2 3 4 5 6': /at most 5/, '0': /more than 0/, '100.5': /at most 100 ETH/, '0.0000001': /not an amount/, 'lots': /not an amount/ };
    for (const [body, why] of Object.entries(refused)) {
      const out = buyAmounts.parseBuyAmounts(body);
      assert.equal(out.ok, false, body);
      assert.match(out.message, why, body);
    }
  });

  it('a stored value that does not read is the defaults; so is a failed read', async () => {
    for (const stored of [['0.01', 'x'], ['999'], [], null]) {
      const db = createFakeSupabase({ accounts: [{ id: 'a', buy_amounts_eth: stored }] });
      assert.deepEqual(await buyAmounts.readBuyAmounts(db.client, 'a'), [...buyAmounts.DEFAULT_BUY_AMOUNTS], JSON.stringify(stored));
    }
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }) };
    assert.deepEqual(await buyAmounts.readBuyAmounts(broken, 'a', { warn() {} }), [...buyAmounts.DEFAULT_BUY_AMOUNTS]);
  });

  it('Telegram passes on only well formed buy buttons', () => {
    for (const ok of [`buy:0.01:${TAG}`, `buy:100:${TAG}`, `buy:edit:${TAG}`]) assert.equal(TelegramBot.isAllowedCallback(ok), true, ok);
    for (const bad of ['buy:0.01', `buy:0.01:${TAG}x`, `buy:1000:${TAG}`, `buy:-1:${TAG}`, `buy:0.1234567:${TAG}`, `sell:0.01:${TAG}`, `buy:0.01:${TAG}:x`]) {
      assert.equal(TelegramBot.isAllowedCallback(bad), false, bad);
    }
  });
});
