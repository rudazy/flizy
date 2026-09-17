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
const { pendingPayAsks } = require('../lib/commands/pending');

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
    assert.match(sent.join('\n'), /No Flizy account has that number/i);
    assert.equal(router.pendingFlowFor(KEY).payCode, false, 'nothing should be left open');
  });

  it('refuses your own code instead of opening a self-send', async () => {
    fake.db.tables.pay_codes.push({ account_id: 'acc-payer', code: '999888777' });
    const sent = [];
    await router.handle(ctxFor(sent), '999888777');
    assert.match(sent.join('\n'), /your own Flizy number/i);
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

  it('takes an amount with an asset, not just a bare number', async () => {
    // "0.01 ETH" and "10 flz" have to reach the send as much as "0.01" does.
    // The parser accepts them; what could silently drop them is the gate in
    // normalizeInput, which is the only thing letting a bare reply count as
    // input at all. So the gate is what this asserts.
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, MERCHANT_CODE);
    assert.equal(router.pendingFlowFor(KEY).payCode, true);

    for (const reply of ['0.01', '0.01 ETH', '0.01 eth', '10 flz', '10 FLZ']) {
      const normalized = router.normalizeInput(ctx, reply);
      assert.notEqual(normalized, null, `"${reply}" must reach the handler`);
      assert.equal(normalized.text, reply, `"${reply}" must arrive unrewritten`);
    }
  });

  it('still ignores chatter while the question is open', async () => {
    // The gate is deliberately narrow: an open question must not turn an
    // ordinary WhatsApp message into a command.
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, MERCHANT_CODE);

    // Not 'how much is that': an existing alias rewrites 'how much is X' into
    // 'price X', so that phrase is a command before this flow ever sees it.
    for (const noise of ['ok thanks', 'send it now', 'thank you', 'i will pay later']) {
      assert.equal(router.normalizeInput(ctx, noise), null, `"${noise}" must be ignored`);
    }
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

describe('pay amount first, then who', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(KEY);
  });

  it('opens with the amount and the reason, and waits for who', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), 'pay 0.001 for coffee');
    const out = sent.join('\n');
    assert.match(out, /0\.001 ETH for coffee/);
    assert.match(out, /Who\?/i);
    assert.equal(router.pendingFlowFor(KEY).payAsk, true);
    assert.equal(router.pendingFlowFor(KEY).payCode, false);
  });

  it('takes a pay code as the identity, not as a new "how much?" paste', async () => {
    // Production bug: the bare-code branch ran first and asked for an amount
    // the payer had already given. The code is who, the amount is already set.
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, 'pay 0.001 for coffee');
    sent.length = 0;
    await router.handle(ctx, MERCHANT_CODE);
    const out = sent.join('\n');
    assert.doesNotMatch(out, /How much/i);
    // Harness has no chain provider, so handleSend stops at the balance read.
    // That reply is the proof we entered send with the stored amount, not a no-op.
    assert.match(out, /Could not check your Flizy wallet/);
    assert.equal(router.pendingFlowFor(KEY).payAsk, false, 'the who-question is spent');
    assert.equal(router.pendingFlowFor(KEY).payCode, false, 'must not open a second amount prompt');
  });

  it('takes a grouped code the same way', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, 'pay 0.001 for coffee');
    sent.length = 0;
    await router.handle(ctx, '622 412 799');
    assert.doesNotMatch(sent.join('\n'), /How much/i);
    assert.match(sent.join('\n'), /Could not check your Flizy wallet/);
    assert.equal(router.pendingFlowFor(KEY).payCode, false);
  });

  it('takes @username as who the same way', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, 'pay 0.001 for coffee');
    sent.length = 0;
    await router.handle(ctx, '@ludarep');
    assert.doesNotMatch(sent.join('\n'), /How much/i);
    assert.match(sent.join('\n'), /Could not check your Flizy wallet/);
    assert.equal(router.pendingFlowFor(KEY).payAsk, false);
  });

  it('wakes WhatsApp on a bare number or @name while Who? is open, not on chatter', () => {
    const wa = {
      channel: 'whatsapp',
      externalId: '2348011111111',
      key: 'whatsapp:2348011111111',
    };
    router.discardPendingFlows(wa.key);
    pendingPayAsks.set(wa.key, { amountEth: '0.001', note: 'coffee', createdAt: Date.now() });
    assert.equal(router.isFlizyCommand(wa, MERCHANT_CODE), true);
    assert.equal(router.isFlizyCommand(wa, '@ludarep'), true);
    assert.equal(router.isFlizyCommand(wa, 'ludarep'), false, 'prompt asks for @username');
    assert.equal(router.isFlizyCommand(wa, 'yes'), false);
    assert.equal(router.isFlizyCommand(wa, 'thanks'), false);
    router.discardPendingFlows(wa.key);
  });
});
