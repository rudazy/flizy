/**
 * Chat checks the daily ETH limit again at confirm, under the account lock.
 *
 * Policy checks it when the plan is made, but the lock is only taken at
 * confirm. A second send that lands in between (another plan, or a site pay)
 * would otherwise let both through against the same allowance.
 *
 * Run: node --test test/dailyLimitConfirm.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({
  from: (table) => fake.client.from(table),
  rpc: (name, args) => fake.client.rpc(name, args),
});

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
      getCode: async () => '0x',
      getBalance: async () => 10n ** 18n,
    },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

// Holding the funds is what must not happen once the limit is spent.
let held = 0;
const realEngine = require('../lib/engine');
const enginePath = require.resolve('../lib/engine');
require.cache[enginePath] = {
  id: enginePath,
  filename: enginePath,
  loaded: true,
  exports: {
    ...realEngine,
    executeClaimHold: async () => {
      held += 1;
      return { ok: true, claim: { id: 'claim-1', claim_token: 'tok' }, txHash: '0xabc' };
    },
  },
};

const router = require('../lib/router');

const TG = '778899128';
const KEY = `telegram:${TG}`;

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
  held = 0;
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-sender',
        email: 'sender@example.com',
        display_name: 'Sender',
        username: 'sender',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x9999999999999999999999999999999999999999',
        unlock_pin_hash: null,
        daily_send_limit_eth: 0.05,
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-sender', channel: 'telegram', external_id: TG, phone_e164: null },
    ],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
    transfers: [],
    claims: [],
  });
}

describe('daily limit at confirm', () => {
  beforeEach(() => {
    seed();
    router.discardPendingFlows(KEY);
  });

  it('refuses when another send used the allowance after the plan was made', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/send 0.03 to 2348099999999');
    assert.equal(router.pendingFlowFor(KEY).send, true, `expected a plan, got:\n${sent.join('\n')}`);

    // A site pay lands between plan and confirm.
    fake.db.tables.transfers.push({
      account_id: 'acc-sender',
      amount_eth: '0.03',
      asset: 'ETH',
      kind: 'transfer',
      status: 'confirmed',
      direction: 'out',
      phone: 'site',
      created_at: new Date().toISOString(),
    });

    sent.length = 0;
    await router.handle(ctx, 'confirm');
    assert.equal(held, 0, 'the claim hold must not run');
    assert.match(sent.join('\n'), /Daily send limit reached/);
  });

  it('goes through when the allowance still covers it', async () => {
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/send 0.03 to 2348099999999');
    await router.handle(ctx, 'confirm');
    assert.equal(held, 1);
  });

  it('does not count an FLZ send against the ETH allowance', async () => {
    fake.db.tables.transfers.push({
      account_id: 'acc-sender',
      amount_eth: '900',
      asset: 'FLZ',
      kind: 'transfer',
      status: 'confirmed',
      direction: 'out',
      created_at: new Date().toISOString(),
    });
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/send 0.03 to 2348099999999');
    await router.handle(ctx, 'confirm');
    assert.equal(held, 1, sent.join('\n'));
  });
});
