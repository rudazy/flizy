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
    assert.match(out, /How much ETH/i);
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
