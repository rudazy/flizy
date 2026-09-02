/**
 * Paste-first pay, driven through the real router.
 *
 * test/pastePay.test.js covers the two parsers in isolation. This one covers
 * the part that actually moves money: what `handle()` does when a bare pay code
 * arrives, and what it does with the answer.
 *
 * Worth having as its own file because the failure modes here are not parsing
 * failures. They are a question left hanging, a "cancel" that does nothing, or
 * a bare number reaching a handler it was never meant to reach — none of which
 * a parser test can see.
 *
 * Run: node --test test/pastePayFlow.test.js
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

const PAYER_TG = '778899124';
const KEY = `telegram:${PAYER_TG}`;
const MERCHANT_CODE = '622412799';
const MERCHANT_WALLET = '0x2222222222222222222222222222222222222222';

function ctxFor(sent) {
  return {
    channel: 'telegram',
    externalId: PAYER_TG,
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
        id: 'acc-payer',
        email: 'payer@example.com',
        display_name: 'Payer',
        username: 'payer',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x1111111111111111111111111111111111111111',
      },
      {
        id: 'acc-merchant',
        email: 'shop@example.com',
        display_name: 'Coffee Shop',
        username: 'ludarep',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: MERCHANT_WALLET,
      },
    ],
    channel_identities: [
      {
        id: 'i1',
        account_id: 'acc-payer',
        channel: 'telegram',
        external_id: PAYER_TG,
        phone_e164: null,
      },
    ],
    pay_codes: [{ account_id: 'acc-merchant', code: MERCHANT_CODE }],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
  });
}

describe('pasting a pay code', () => {
  beforeEach(() => {
    seed();
    // Pending flows are module state, so one test must not inherit another's.
    router.discardPendingFlows(KEY);
  });

  it('answers with the current username and asks for an amount', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), MERCHANT_CODE);
    const out = sent.join('\n');
    assert.match(out, /@ludarep/, 'must name who is being paid');
    assert.match(out, /How much/i);
    assert.equal(router.pendingFlowFor(KEY).payCode, true, 'the question should be open');
  });

  it('reads the code the way it is printed', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), '622 412 799');
    assert.match(sent.join('\n'), /@ludarep/);
    assert.equal(router.pendingFlowFor(KEY).payCode, true);
  });

  it('shows the name live, so a rename cannot leave a stale one on screen', async () => {
    // The whole point of routing on the code: the sheet never changes, the name
    // shown always does.
    fake.db.tables.accounts.find((a) => a.id === 'acc-merchant').username = 'cafex';
    const sent = [];
    await router.handle(ctxFor(sent), MERCHANT_CODE);
    assert.match(sent.join('\n'), /@cafex/);
    assert.equal(/@ludarep/.test(sent.join('\n')), false, 'the old name must not appear');
  });

  it('says so plainly when no account has that code', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), '111222333');
    assert.match(sent.join('\n'), /No Flizy account has that pay code/i);
    assert.equal(router.pendingFlowFor(KEY).payCode, false, 'nothing should be left open');
  });

  it('refuses your own code instead of opening a self-send', async () => {
    fake.db.tables.pay_codes.push({ account_id: 'acc-payer', code: '999888777' });
    const sent = [];
    await router.handle(ctxFor(sent), '999888777');
    assert.match(sent.join('\n'), /your own pay code/i);
    assert.equal(router.pendingFlowFor(KEY).payCode, false);
  });
});

describe('the open question', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(KEY);
  });

  it('is closed by cancel, and says nothing was sent', async () => {
    // The prompt offers "Or: cancel". handleCancel names each flow explicitly,
    // so a new flow is invisible to it until added — this is what proves the
    // offer is real.
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, MERCHANT_CODE);
    assert.equal(router.pendingFlowFor(KEY).payCode, true);

    sent.length = 0;
    await router.handle(ctx, 'cancel');
    assert.match(sent.join('\n'), /Nothing was sent/i);
    assert.equal(router.pendingFlowFor(KEY).payCode, false, 'cancel must actually close it');
  });

  it('re-targets when a second code is pasted, rather than reading it as an amount', async () => {
    // Nobody sends 622,412,799 ETH. Reading a pasted code as an amount would be
    // a baffling refusal, so the code is checked first.
    fake.db.tables.accounts.push({
      id: 'acc-other',
      email: 'other@example.com',
      display_name: 'Other',
      username: 'otherguy',
      balance_eth: 0,
      is_admin: false,
      agent_wallet_address: '0x5555555555555555555555555555555555555555',
    });
    fake.db.tables.pay_codes.push({ account_id: 'acc-other', code: '444555666' });

    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, MERCHANT_CODE);

    sent.length = 0;
    await router.handle(ctx, '444555666');
    assert.match(sent.join('\n'), /@otherguy/, 'the second code should re-target');
    assert.equal(router.pendingFlowFor(KEY).payCode, true, 'still waiting on an amount');
  });

  it('survives an unrelated command, the same way the sibling flows do', async () => {
    // Documenting real behaviour rather than wishing for another: commands
    // dispatched earlier in handle() return before reaching this flow's
    // cleanup, so the question stays open. pendingPayAsks and
    // pendingMerchantSaves behave identically, and PENDING_TTL_MS bounds it.
    //
    // It matters more here than for those two, because an open pay question is
    // what makes a bare number count as input at all (see normalizeInput). So a
    // stale question can still catch an amount typed for another reason inside
    // the TTL window. Tightening that means changing where every pending flow
    // is cleared, not just this one — worth doing, but not smuggled in here.
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, MERCHANT_CODE);

    sent.length = 0;
    // 'help' rather than 'balance': balance reads the chain and this harness
    // has no provider.
    await router.handle(ctx, 'help');
    assert.equal(router.pendingFlowFor(KEY).payCode, true, 'still open, by convention');

    // And it is still answerable, rather than wedged.
    sent.length = 0;
    await router.handle(ctx, 'cancel');
    assert.equal(router.pendingFlowFor(KEY).payCode, false);
  });
});
