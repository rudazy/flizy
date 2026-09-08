/**
 * Refusing a request, and the bug that made refusing it impossible to reach.
 *
 * Two things are pinned here, and the second matters more than the first.
 *
 * 1. A payer can decline a request addressed to them, the row becomes terminal,
 *    and the person who asked is told. Declining is deliberately distinct from
 *    cancelling: the asker withdraws, the recipient refuses, and a split needs
 *    to tell those apart.
 *
 * 2. **An account-addressed request is visible to the account it names.**
 *    This is the regression that shipped. `listIncomingRequests` only runs its
 *    account-mode query `if (identity.accountId)`, and `resolveClaimIdentity`
 *    did not return one -- so every request made by @username was invisible to
 *    the person it was for, and nothing failed anywhere to say so. Split bill
 *    creates exactly those rows, so the whole feature was unpayable in
 *    production while its unit tests passed.
 *
 *    The unit tests missed it because they handed `listIncomingRequests` an
 *    identity object built by hand, with `accountId` already set. Nothing drove
 *    the real path. These tests go through the router for that reason.
 *
 * Run: node --test test/requestDecline.test.js
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
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const { resolveClaimIdentity } = require('../lib/commands/account');
const { formatRequestDeclinedNotice } = require('../lib/paymentRequests');

const ORG = 'acc-org';
const PAYER = 'acc-payer';
const OTHER = 'acc-other';
const ORG_WA = '2348012345678';
const PAYER_WA = '2348099999999';
const OTHER_WA = '2348077777777';

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
      account(OTHER, 'nosy', '0x3333333333333333333333333333333333333333'),
    ],
    channel_identities: [
      { id: 'i1', account_id: ORG, channel: 'whatsapp', external_id: ORG_WA, phone_e164: ORG_WA },
      { id: 'i2', account_id: PAYER, channel: 'whatsapp', external_id: PAYER_WA, phone_e164: PAYER_WA },
      { id: 'i3', account_id: OTHER, channel: 'whatsapp', external_id: OTHER_WA, phone_e164: OTHER_WA },
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

const requests = () => fake.db.tables.payment_requests || [];
const notifications = () => fake.db.tables.notifications || [];

/**
 * The regression. An identity that cannot name its own account makes every
 * account-addressed request unreachable, which is silent rather than loud.
 */
describe('an identity knows which account it is', () => {
  it('carries accountId, which the account-mode query is gated on', async () => {
    const identity = await resolveClaimIdentity(ctxFor(PAYER_WA, []));
    assert.equal(identity.accountId, PAYER);
  });

  it('still carries the other addressing keys', async () => {
    const identity = await resolveClaimIdentity(ctxFor(PAYER_WA, []));
    assert.equal(identity.waSenderId, PAYER_WA);
    assert.ok(Array.isArray(identity.identities));
    assert.ok(Array.isArray(identity.emails));
  });
});

describe('a request made by @username reaches the person it names', () => {
  it('shows up for the payer, not only for the sender', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    assert.equal(requests().length, 1, 'split wrote no request');
    assert.equal(requests()[0].from_account_id, PAYER, 'not account-addressed');

    const seen = await say(PAYER_WA, 'flizy pay');
    assert.match(seen, /Pay this request\?/);
    assert.match(seen, /0\.025 ETH/);
  });

  it('does not show up for somebody else', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    const seen = await say(OTHER_WA, 'flizy pay');
    assert.match(seen, /No payment requests/);
  });
});

/**
 * The sibling bug, found in production by replying "1" to a real split rather
 * than by any test here.
 *
 * startPayRequest authorized by comparing from_wa_hint against the account's
 * phones, which was right while phone was the only way to address a request.
 * Since 20260907000000 it is one of four, and the other three leave that column
 * null -- so an account-addressed request was listed, notified, and then
 * refused at the till as "This request is for a different phone number".
 *
 * The property: what the menu lists and what pay accepts cannot disagree.
 */
describe('a listed request is a payable request', () => {
  it('does not refuse an account-addressed request as a phone mismatch', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    await say(PAYER_WA, 'flizy pay');
    const said = await say(PAYER_WA, 'confirm');

    assert.doesNotMatch(said, /different phone number/);
    assert.doesNotMatch(said, /not addressed to you/);
    assert.doesNotMatch(said, /Could not verify your phone/);
    // It gets as far as reading the wallet, which is the step after
    // authorization. The stub provider has no getBalance, so that is where it
    // stops here -- past the gate, which is what this pins.
    assert.match(said, /Could not check your Flizy wallet/);
  });

  // The other half -- that somebody else cannot pay it -- is covered upstream by
  // "does not show up for somebody else": the menu is the only way to reach
  // startPayRequest, and it is filtered by the same listIncomingRequests this
  // now authorizes against. A test here would have to export an internal to say
  // anything the menu test does not already prove.
});

describe('declining', () => {
  it('ends the request and tells the person who asked', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    await say(PAYER_WA, 'flizy pay');
    const said = await say(PAYER_WA, 'flizy decline');

    assert.match(said, /Declined 0\.025 ETH/);
    assert.match(said, /Nothing moved/);

    const row = requests()[0];
    assert.equal(row.status, 'declined');
    assert.ok(row.declined_at, 'declined_at was not set');

    const body = notifications().map((n) => n.body || n.message || '').join('\n');
    assert.match(body, /declined your request for 0\.025 ETH/);
    assert.match(body, /Split: dinner/, 'the organiser needs to know which split');
  });

  it('is terminal: the request is gone from the payer menu afterwards', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    await say(PAYER_WA, 'flizy pay');
    await say(PAYER_WA, 'flizy decline');
    assert.match(await say(PAYER_WA, 'flizy pay'), /No payment requests/);
  });

  it('leaves the money alone', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    await say(PAYER_WA, 'flizy pay');
    await say(PAYER_WA, 'flizy decline');
    assert.equal((fake.db.tables.transfers || []).length, 0, 'a decline moved money');
  });
});

/**
 * Most identities in production are Telegram, so the slash form has to reach
 * the same place the bare word does. Checking that the text normalizes is not
 * the same as checking the router acts on it, so this drives the real path.
 */
describe('declining on Telegram', () => {
  const TG = '55501';

  async function tgSay(text) {
    const sent = [];
    await router.handle(
      {
        channel: 'telegram',
        externalId: TG,
        key: `telegram:${TG}`,
        raw: {},
        reply: async (t) => sent.push(t),
        resolveVerifiedPhone: async () => null,
        requestPhone: async () => {},
      },
      text
    );
    return sent.join('\n');
  }

  it('refuses with /decline, and the asker is told', async () => {
    fake.db.tables.accounts.push(account('acc-tg', 'tguser', '0x4444444444444444444444444444444444444444'));
    fake.db.tables.channel_identities.push({
      id: 'i4', account_id: 'acc-tg', channel: 'telegram', external_id: TG,
    });

    await say(ORG_WA, 'flizy split 0.04 with tguser for taxi');
    assert.equal(requests().length, 1);

    assert.match(await tgSay('/pay'), /Pay this request\?/);
    assert.match(await tgSay('/decline'), /Declined/);

    assert.equal(requests()[0].status, 'declined');
    const body = notifications().map((n) => n.body || n.message || '').join('\n');
    assert.match(body, /declined your request/);
  });
});

/**
 * declined and cancelled are different events by different actors. A split with
 * four rows has to be readable afterwards, and it would not be if refusing and
 * withdrawing wrote the same status.
 */
describe('declined is not cancelled', () => {
  it('the organiser cancelling writes cancelled', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    await say(ORG_WA, 'flizy requests');
    await say(ORG_WA, 'confirm');
    assert.equal(requests()[0].status, 'cancelled');
    assert.equal(requests()[0].declined_at, undefined);
  });

  it('the payer refusing writes declined', async () => {
    await say(ORG_WA, 'flizy split 0.05 with ludarep for dinner');
    await say(PAYER_WA, 'flizy pay');
    await say(PAYER_WA, 'flizy decline');
    assert.equal(requests()[0].status, 'declined');
  });
});

describe('the notice the organiser reads', () => {
  it('names who refused and says no money moved', () => {
    const t = formatRequestDeclinedNotice({ amountEth: '0.025', byLabel: '@ludarep' });
    assert.match(t, /@ludarep declined your request for 0\.025 ETH/);
    assert.match(t, /Nothing moved/);
  });

  it('names the split when there is one', () => {
    const t = formatRequestDeclinedNotice({ amountEth: '0.025', byLabel: '@a', billNote: 'rent' });
    assert.match(t, /Split: rent/);
  });

  it('still reads when nobody can be named', () => {
    assert.match(formatRequestDeclinedNotice({ amountEth: '0.01' }), /someone declined/);
  });
});
