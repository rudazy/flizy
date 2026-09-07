/**
 * An amount we cannot price gets an answer on WhatsApp, not silence.
 *
 * This is a wake-gate test as much as a copy test. `send ₦10,000 to john`
 * parsed as nothing, so `isFlizyCommandBody` said no, so on WhatsApp the bot
 * never woke and the user got **nothing at all**. Adding a reply in the router
 * would not have been enough on its own — the reply was unreachable.
 *
 * That is the property `test/whatsappGate.test.js` guards in general:
 * *whatever routes must also wake it*. This file pins the one case, end to end
 * through `handle()`, because it is the case that was broken.
 *
 * Run: node --test test/amountCurrencyReply.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

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
    provider: { getCode: async () => '0x' },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const { isFlizyCommandBody } = require('../lib/commands/parse');

const WA = '2348012345678';

/** Everything the bot said. A first-touch welcome can precede the answer. */
async function say(text) {
  const sent = [];
  const ctx = {
    channel: 'whatsapp',
    externalId: WA,
    key: `whatsapp:${WA}`,
    raw: {},
    reply: async (t) => {
      sent.push(t);
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
  };
  await router.handle(ctx, text);
  return sent.join('\n');
}

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-payer',
        email: 'payer@example.com',
        display_name: 'Payer',
        username: 'payer',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x1111111111111111111111111111111111111111',
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-payer', channel: 'whatsapp', external_id: WA, phone_e164: WA },
    ],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
  });
  router.discardPendingFlows();
});

describe('the gate and the reply agree', () => {
  it('wakes on a payment command in a currency we cannot price', () => {
    assert.equal(isFlizyCommandBody('send ₦10,000 to john'), true);
    assert.equal(isFlizyCommandBody('send $10 to john'), true);
    assert.equal(isFlizyCommandBody('send N5000 to john'), true);
    assert.equal(isFlizyCommandBody('request NGN 200 from ada'), true);
  });

  it('stays asleep for a price mentioned in conversation', () => {
    // WhatsApp is a shared inbox. This predicate decides whether the bot
    // speaks at all, so it must not fire on people talking about money.
    assert.equal(isFlizyCommandBody('it cost $10 yesterday'), false);
    assert.equal(isFlizyCommandBody('₦10,000 for the shoes'), false);
    assert.equal(isFlizyCommandBody('hello there'), false);
  });
});

describe('WhatsApp gets words instead of nothing', () => {
  it('answers a naira send', async () => {
    const said = await say('flizy send ₦10,000 to john');
    assert.match(said, /Naira amounts are not supported yet/);
    assert.match(said, /flizy send 0\.01 to name/);
  });

  it('answers a dollar send', async () => {
    const said = await say('flizy send $10 to john');
    assert.match(said, /Dollar amounts are not supported yet/);
  });

  it('answers N5000 rather than hunting for a token called n5000', async () => {
    const said = await say('flizy send N5000 to john');
    assert.match(said, /Naira amounts are not supported yet/);
    assert.equal(/n5000/i.test(said), false, 'still treating N5000 as a ticker');
  });

  it('leaves a normal send alone', async () => {
    const said = await say('flizy send 0.01 to john');
    assert.equal(/not supported yet/.test(said), false, said);
  });
});

/**
 * The third shape. `send 10000 to john` always parsed, and policy always
 * refused it -- but with "Max per send is 0.1 ETH", which answers a question
 * about ETH to someone who was thinking in naira.
 */
describe('a bare amount that was not meant as ETH', () => {
  it('asks for the asset instead of quoting an ETH cap', async () => {
    const said = await say('flizy send 10000 to john');
    assert.match(said, /Name the asset for an amount this size/);
    assert.match(said, /flizy send 10000 flz to john/);
    // The guard returns before policy, so the cap wording cannot also appear.
    assert.equal(/Try a smaller amount/.test(said), false, said);
  });

  it('leaves an amount that plausibly meant ETH to the existing cap', async () => {
    const said = await say('flizy send 0.5 to john');
    assert.equal(/Name the asset/.test(said), false, said);
  });

  it('does not fire when the asset was named', async () => {
    const said = await say('flizy send 10000 flz to john');
    assert.equal(/Name the asset/.test(said), false, said);
  });
});
