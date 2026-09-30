/**
 * Two invariants about payout destinations.
 *
 * 1. No chat command, reply or callback may create or modify a trusted payout
 *    destination.
 * 2. A trusted destination cannot receive funds until its hold has expired.
 *
 * Both are driven through the real entry point: raw text into router.handle,
 * the same call the WhatsApp and Telegram clients make. A unit test that built
 * its own intent and called a handler directly would pass while the wiring was
 * broken, which is how the gap being closed here survived in the first place.
 *
 * Invariant 2 is asserted at the policy layer, not by checking a list is
 * filtered. evaluateSendPolicy is what every send path calls, so a held
 * destination is refused on paths no interface currently reaches.
 *
 * Run: node --test test/trustedAuthority.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
process.env.SITE_URL = 'https://flizy.test';

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
const trusted = require('../lib/trusted');
const parse = require('../lib/commands/parse');
const { evaluateSendPolicy } = require('../lib/engine/policy');

const TG_ID = '556677001';
const KEY = `telegram:${TG_ID}`;
const WALLET = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';

function ctxFor(sent) {
  return {
    channel: 'telegram',
    externalId: TG_ID,
    key: KEY,
    raw: {},
    reply: async (text) => {
      sent.push(text);
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
  };
}

/** @param {Array<object>} trustedRows */
function seed(trustedRows = []) {
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-a',
        email: 'a@example.com',
        display_name: 'A',
        balance_eth: 10,
        is_admin: false,
        agent_wallet_address: '0x9999999999999999999999999999999999999999',
        unlock_pin_hash: null,
        daily_send_limit_eth: 0,
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-a', channel: 'telegram', external_id: TG_ID, phone_e164: null },
    ],
    trusted_addresses: trustedRows,
    trusted_add_tickets: [],
    link_codes: [],
    users: [],
    sessions: [],
    notifications: [],
  });
}

const rows = () => fake.db.tables.trusted_addresses || [];
const tickets = () => fake.db.tables.trusted_add_tickets || [];

/** A destination the way the database makes one: held for 24 hours. */
function heldRow(address, label) {
  return {
    id: `t-${label}`,
    account_id: 'acc-a',
    address,
    label,
    status: 'active',
    active_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };
}

function usableRow(address, label) {
  return {
    id: `t-${label}`,
    account_id: 'acc-a',
    address,
    label,
    status: 'active',
    active_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString(),
  };
}

describe('invariant 1: chat cannot create a payout destination', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(KEY);
  });

  it('add wallet writes nothing and hands back a site link', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, `/add wallet ${WALLET}`);

    assert.equal(rows().length, 0, 'chat must not write a destination');
    const out = sent.join('\n');
    assert.match(out, /site/i, 'the reply must send them to the site');
    assert.match(out, /flizy\.test\/dashboard\/account\?add=/, 'a ticket link is offered');
    assert.equal(tickets().length, 1, 'the address is carried on a ticket');
    assert.equal(tickets()[0].address, WALLET);
    assert.equal(tickets()[0].account_id, 'acc-a', 'ticket is bound to the minting account');
  });

  it('the follow-up that used to complete the add now does nothing', async () => {
    const sent = [];
    const ctx = ctxFor(sent);

    await router.handle(ctx, `/add wallet ${WALLET}`);
    sent.length = 0;
    // The old flow took a bare word here and wrote the destination.
    await router.handle(ctx, 'john');

    assert.equal(rows().length, 0, 'a bare name must never add a destination');
  });

  it('the ticket alone is not authority: it carries an address and no more', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), `/add wallet ${WALLET}`);
    const ticket = tickets()[0];

    assert.ok(ticket.code, 'ticket has a code');
    assert.ok(new Date(ticket.expires_at).getTime() > Date.now(), 'ticket is live');
    assert.ok(
      new Date(ticket.expires_at).getTime() - Date.now() <= 11 * 60 * 1000,
      'ticket expires in about ten minutes'
    );
    assert.equal(ticket.used_at ?? null, null, 'unspent until the add succeeds');
    assert.equal(rows().length, 0, 'minting a ticket is not adding a destination');
  });

  it('the bot module exports no writer at all', () => {
    // Structural, not behavioural. An importable addTrusted in the bot module is
    // a loaded function for the next chat feature to pick up, which is exactly
    // how the original gap happened.
    assert.equal(typeof trusted.addTrusted, 'undefined');
    assert.equal(typeof trusted.removeTrusted, 'undefined');
    assert.equal(typeof trusted.isTrustedAddress, 'function');
    assert.equal(typeof trusted.cancelPendingTrusted, 'function');
  });
});

describe('invariant 2: a held destination cannot receive funds', () => {
  beforeEach(() => {
    seed([heldRow(WALLET, 'john')]);
  });

  it('isTrustedAddress refuses it while the hold runs', async () => {
    assert.equal(await trusted.isTrustedAddress('acc-a', WALLET), false);
  });

  it('the send policy denies it, which is every send path at once', async () => {
    const decision = await evaluateSendPolicy(
      {
        amountEth: '0.01',
        toAddress: WALLET,
        asset: 'ETH',
        actor: {
          accountId: 'acc-a',
          userId: 'u1',
          isAdmin: false,
          channel: 'telegram',
          externalId: TG_ID,
          creditEth: 10,
        },
      },
      { enforceCredit: false }
    );
    assert.equal(decision.decision, 'DENY');
    assert.equal(decision.reason, 'untrusted');
    assert.equal(decision.checks.trusted, false);
  });

  it('the refusal says it is held, not that they should go and add it', async () => {
    // The generic untrusted copy sends them to the site to add a destination
    // they already added. During the first 24 hours of any destination's life
    // that is the single most likely message this product shows, so it gets to
    // be right rather than merely safe.
    const decision = await evaluateSendPolicy(
      {
        amountEth: '0.01',
        toAddress: WALLET,
        asset: 'ETH',
        actor: {
          accountId: 'acc-a',
          userId: 'u1',
          isAdmin: false,
          channel: 'telegram',
          externalId: TG_ID,
          creditEth: 10,
        },
      },
      { enforceCredit: false }
    );
    assert.equal(decision.decision, 'DENY', 'the decision itself must not soften');
    assert.match(decision.message, /24 hours/);
    assert.match(decision.message, /cancel wallet/);
    assert.doesNotMatch(decision.message, /Add them as trusted/);
  });

  it('a destination that was never added still gets the generic refusal', async () => {
    const decision = await evaluateSendPolicy(
      {
        amountEth: '0.01',
        toAddress: MERCHANT,
        asset: 'ETH',
        actor: {
          accountId: 'acc-a',
          userId: 'u1',
          isAdmin: false,
          channel: 'telegram',
          externalId: TG_ID,
          creditEth: 10,
        },
      },
      { enforceCredit: false }
    );
    assert.equal(decision.decision, 'DENY');
    assert.match(decision.message, /Add them as trusted/);
  });

  it('the same destination is allowed once the hold has passed', async () => {
    seed([usableRow(WALLET, 'john')]);
    assert.equal(await trusted.isTrustedAddress('acc-a', WALLET), true);

    const decision = await evaluateSendPolicy(
      {
        amountEth: '0.01',
        toAddress: WALLET,
        asset: 'ETH',
        actor: {
          accountId: 'acc-a',
          userId: 'u1',
          isAdmin: false,
          channel: 'telegram',
          externalId: TG_ID,
          creditEth: 10,
        },
      },
      { enforceCredit: false }
    );
    assert.notEqual(decision.reason, 'untrusted');
  });

  it('a cancelled destination is refused even after its hold would have passed', async () => {
    seed([{ ...usableRow(WALLET, 'john'), status: 'cancelled' }]);
    assert.equal(await trusted.isTrustedAddress('acc-a', WALLET), false);
  });
});

describe('chat may remove authority: cancelling a held destination', () => {
  beforeEach(() => {
    seed([heldRow(WALLET, 'john')]);
    router.discardPendingFlows(KEY);
  });

  it('cancel wallet marks it cancelled through the real entry point', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), '/cancel wallet john');

    assert.match(sent.join('\n'), /Cancelled/i);
    assert.equal(rows()[0].status, 'cancelled');
    assert.equal(await trusted.isTrustedAddress('acc-a', WALLET), false);
  });

  it('cancel with no argument clears everything still held', async () => {
    seed([heldRow(WALLET, 'john'), heldRow(MERCHANT, 'shop')]);
    const sent = [];
    await router.handle(ctxFor(sent), '/cancel wallet');

    assert.equal(rows().filter((r) => r.status === 'cancelled').length, 2);
  });

  it('it cannot touch a destination that is already in use', async () => {
    seed([usableRow(WALLET, 'john')]);
    const sent = [];
    await router.handle(ctxFor(sent), '/cancel wallet john');

    // Deleting a live destination is damage an attacker would enjoy too, so it
    // stays on the site behind the password.
    assert.equal(rows()[0].status, 'active', 'an active destination is not cancellable from chat');
    assert.match(sent.join('\n'), /Nothing is waiting/i);
  });
});

describe('re-adding a cancelled destination is possible, and still earns a hold', () => {
  /*
   * This one is pinned at the source, not driven, and that is a real limit
   * worth stating: the behaviour lives in a Postgres trigger and in an upsert
   * the site issues, neither of which this suite can execute. It was verified
   * against the database directly.
   *
   * The bug it guards against: cancel does not delete the row, so re-adding the
   * same address lands on it as an update rather than an insert. The upsert did
   * not mention `status`, so the row stayed cancelled while the API answered
   * 200 and the UI showed a saved destination that could never receive
   * anything, with no way for the owner to see or clear it. Silent, permanent,
   * and reached by following the advice in our own cancel notification.
   */
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  it('the site add states status, so the row cannot stay cancelled', () => {
    const src = fs.readFileSync(path.join(root, 'web', 'lib', 'trusted.ts'), 'utf8');
    const upsert = src.slice(src.indexOf('.upsert('), src.indexOf('onConflict'));
    assert.match(upsert, /status: 'active'/, 'the upsert must state status, not leave it');
  });

  it('the trigger re-holds a destination that comes back from cancelled', () => {
    const sql = fs.readFileSync(
      path.join(root, 'supabase', 'migrations', '20260923000000_trusted_destination_hold.sql'),
      'utf8'
    );
    const fn = sql.slice(
      sql.indexOf('create or replace function public.trusted_addresses_apply_hold'),
      sql.indexOf('drop trigger if exists')
    );
    assert.match(
      fn,
      /old\.status = 'cancelled' and new\.status = 'active'/,
      'the cancelled -> active transition must be handled'
    );
    // And it must set a fresh hold on that branch, or re-adding would be a way
    // to skip the 24 hours entirely.
    const branch = fn.slice(fn.indexOf("old.status = 'cancelled'"));
    assert.match(branch.slice(0, 200), /active_at := now\(\) \+ interval '24 hours'/);
  });
});

describe('the command is wired into both the wake gate and the router', () => {
  it('the parser recognises every form', () => {
    assert.deepEqual(parse.parseCancelTrustedCommand('cancel wallet'), { target: null });
    assert.deepEqual(parse.parseCancelTrustedCommand('cancel wallet john'), { target: 'john' });
    assert.deepEqual(parse.parseCancelTrustedCommand('cancel address 0xabc'), { target: '0xabc' });
    assert.equal(parse.parseCancelTrustedCommand('cancel'), null);
  });

  it('the wake gate lists it, so a bare message reaches the router', () => {
    // A command the router handles but the wake gate does not know is dead on
    // WhatsApp, where an unprefixed message is ignored unless it wakes the bot.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'commands', 'parse.js'),
      'utf8'
    );
    assert.match(src, /Boolean\(parseCancelTrustedCommand\(t\)\) \|\|/);
  });
});
