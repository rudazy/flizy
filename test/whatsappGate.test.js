/**
 * The WhatsApp wake gate, and the reply that answers an open question.
 *
 * WhatsApp is a shared inbox, so index.js refuses to wake the bot unless
 * isFlizyCommand says yes. Telegram has no such gate -- telegram.js calls
 * handle() directly. That asymmetry is why every bug in this area looked the
 * same: it worked on Telegram and did nothing at all on WhatsApp, silently,
 * with no error anywhere to notice.
 *
 * It happened three times. A bare "save" after a first payment; the prefixed
 * "flizy save"; an amount after a pasted pay code. Each time normalizeInput had
 * been taught about the new flow and isFlizyCommand had not, so the bot either
 * woke and dropped the reply or never woke at all.
 *
 * Both gates now ask pendingReply, so this file tests the property that matters
 * rather than the three symptoms: **whatever wakes the bot must also route, and
 * whatever routes must also wake it.** A new flow that breaks that fails here.
 *
 * Run: node --test test/whatsappGate.test.js
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

const WA = '2348012345678';
const WA_KEY = `whatsapp:${WA}`;
const MERCHANT_CODE = '622412799';

function waCtx(sent = []) {
  return {
    channel: 'whatsapp',
    externalId: WA,
    key: WA_KEY,
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
        display_name: 'Shop',
        username: 'ludarep',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x2222222222222222222222222222222222222222',
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-payer', channel: 'whatsapp', external_id: WA, phone_e164: WA },
    ],
    pay_codes: [{ account_id: 'acc-merchant', code: MERCHANT_CODE }],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
  });
}

/** Exactly what index.js does before it will hand a message to the router. */
function wakesOnWhatsApp(ctx, text) {
  const flow = router.pendingFlowFor(ctx.key);
  const midFlow =
    flow.walletAdd || flow.claimMenu || flow.unlock || flow.choice || flow.namedSend;
  return Boolean(router.isFlizyCommand(ctx, text)) || Boolean(midFlow);
}

describe('an open pay question answers on WhatsApp, prefixed or not', () => {
  beforeEach(async () => {
    seed();
    router.discardPendingFlows(WA_KEY);
    // Open the question the way a real payer would.
    await router.handle(waCtx(), `flizy ${MERCHANT_CODE}`);
  });

  it('opened the question at all', () => {
    assert.equal(router.pendingFlowFor(WA_KEY).payCode, true);
  });

  it('wakes AND routes for every shape of the answer', () => {
    // The bug was that these two disagreed. Asserting them together is the
    // point: waking without routing drops the reply, routing without waking
    // never happens at all.
    const ctx = waCtx();
    for (const reply of ['0.01', 'flizy 0.01', '5 flz', 'flizy 5 flz', 'flizy 5 FLZ']) {
      assert.equal(wakesOnWhatsApp(ctx, reply), true, `"${reply}" must wake the bot`);
      assert.notEqual(router.normalizeInput(ctx, reply), null, `"${reply}" must route`);
    }
  });

  it('strips the prefix so both channels produce the same answer', () => {
    const ctx = waCtx();
    assert.equal(router.normalizeInput(ctx, 'flizy 5 flz').text, '5 flz');
    assert.equal(router.normalizeInput(ctx, '5 flz').text, '5 flz');
  });

  it('still ignores ordinary chatter while the question is open', () => {
    const ctx = waCtx();
    for (const noise of ['ok thanks', 'i will pay later', 'thank you']) {
      assert.equal(wakesOnWhatsApp(ctx, noise), false, `"${noise}" must not wake it`);
      assert.equal(router.normalizeInput(ctx, noise), null, `"${noise}" must not route`);
    }
  });

  it('cancel still closes it', async () => {
    const sent = [];
    const ctx = waCtx(sent);
    assert.equal(wakesOnWhatsApp(ctx, 'cancel'), true);
    await router.handle(ctx, 'cancel');
    assert.equal(router.pendingFlowFor(WA_KEY).payCode, false);
  });
});

describe('with no question open, a bare amount is not input', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(WA_KEY);
  });

  it('does not wake the bot', () => {
    // The narrowness is the safety property. If a bare number ever wakes
    // WhatsApp on its own, ordinary chat becomes commands.
    const ctx = waCtx();
    for (const text of ['0.01', '5 flz', 'flizy 5 flz']) {
      assert.equal(wakesOnWhatsApp(ctx, text), false, `"${text}" must not wake it`);
    }
  });

  it('bare forms do not route either', () => {
    const ctx = waCtx();
    for (const text of ['0.01', '5 flz']) {
      assert.equal(router.normalizeInput(ctx, text), null, `"${text}" must not route`);
    }
  });

  it('the prefixed form still normalises, which is harmless here', () => {
    // Documenting real behaviour rather than wishing for another. Any text
    // carrying the prefix is passed through by normalizeInput, command or not
    // -- "flizy 5 flz" becomes "5 flz" and then matches no handler. It never
    // gets that far on WhatsApp anyway, because the wake gate above refused it,
    // which is the assertion that actually protects the shared inbox.
    const ctx = waCtx();
    assert.equal(router.normalizeInput(ctx, 'flizy 5 flz').text, '5 flz');
    assert.equal(wakesOnWhatsApp(ctx, 'flizy 5 flz'), false, 'and it never reaches the router');
  });
});
