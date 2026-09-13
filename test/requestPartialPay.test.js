/**
 * Paying part of a request, the way the prompt actually asks for it.
 *
 * The prompt says reply `0.01` to pay part. Production answered that with
 * "Invalid amount / flizy send 0.001 to john" because the menu handler passed
 * the whole parseBareAmount object into startPayRequest, which stringifies to
 * "[object Object]" and dies in parseEther. People then retried `pay 0.03 eth`
 * and `pay 0.01`, which the menu did not read as an amount at all.
 *
 * These tests drive the router. A parser test cannot see the object being
 * handed to the engine.
 *
 * Run: node --test test/requestPartialPay.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

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
    provider: {
      getBalance: async () => ethers.parseEther('5'),
    },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');

const ORG = 'acc-org';
const PAYER = 'acc-payer';
const ORG_WA = '2348012345678';
const PAYER_WA = '2348099999999';

function account(id, username, address) {
  return {
    id,
    username,
    email: `${username}@e.com`,
    display_name: username,
    balance_eth: 0,
    is_admin: false,
    email_verified: true,
    agent_wallet_address: address,
  };
}

function ctxFor(wa, sent) {
  return {
    channel: 'whatsapp',
    externalId: wa,
    key: `whatsapp:${wa}`,
    raw: {},
    reply: async (t) => sent.push(t),
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
  };
}

async function say(wa, text) {
  const sent = [];
  await router.handle(ctxFor(wa, sent), text);
  return sent.join('\n');
}

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [
      account(ORG, 'whuffi', '0x1111111111111111111111111111111111111111'),
      account(PAYER, 'ludarep', '0x2222222222222222222222222222222222222222'),
    ],
    channel_identities: [
      { id: 'i1', account_id: ORG, channel: 'whatsapp', external_id: ORG_WA, phone_e164: ORG_WA },
      { id: 'i2', account_id: PAYER, channel: 'whatsapp', external_id: PAYER_WA, phone_e164: PAYER_WA },
    ],
    payment_requests: [],
    notifications: [],
    pots: [],
    transfers: [],
    pay_codes: [],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
    account_emails: [],
  });
});

async function openPayPrompt() {
  const asked = await say(ORG_WA, 'flizy request 0.05 from ludarep');
  assert.match(asked, /Payment request created/);
  const seen = await say(PAYER_WA, 'flizy pay');
  assert.match(seen, /Pay this request\?/);
  assert.match(seen, /0\.05 ETH/);
  return seen;
}

describe('a bare amount pays part of the open request', () => {
  it('does not treat 0.03 as a new send', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, '0.03');
    assert.doesNotMatch(said, /Invalid amount/);
    assert.doesNotMatch(said, /send 0\.001 to john/);
    assert.match(said, /Amount:\s+0\.03 ETH/);
  });

  it('accepts 0.03 eth the same way', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, '0.03 eth');
    assert.match(said, /Amount:\s+0\.03 ETH/);
  });

  it('accepts pay 0.03 eth', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, 'flizy pay 0.03 eth');
    assert.doesNotMatch(said, /Invalid amount/);
    assert.match(said, /Amount:\s+0\.03 ETH/);
  });

  it('accepts pay 0.01', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, 'flizy pay 0.01');
    assert.match(said, /Amount:\s+0\.01 ETH/);
  });

  it('still pays the rest on confirm', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, 'confirm');
    assert.match(said, /Amount:\s+0\.05 ETH/);
  });

  it('refuses more than is owed', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, '0.08');
    assert.match(said, /more than is owed/);
  });

  it('refuses a token amount instead of charging that many ETH', async () => {
    await openPayPrompt();
    const said = await say(PAYER_WA, '10 FLZ');
    assert.match(said, /paid in ETH/);
    assert.doesNotMatch(said, /Amount:\s+10 ETH/);
  });
});
