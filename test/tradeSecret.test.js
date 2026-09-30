/**
 * A chat trade of a token Flizy has not verified asks for the PIN or account
 * password at confirm, every time.
 *
 * Any token other than ETH, WETH and FLZ trades against a pool whoever deployed
 * it can seed and drain. The output lands in this wallet, but the ETH put in can
 * still be taken, so a stolen phone must not be able to do it with CONFIRM
 * alone. ETH/FLZ trades are unchanged.
 *
 * Run: node --test test/tradeSecret.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
const { hashPin } = require('../lib/cryptoPin');

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

// Quoting is stubbed so no RPC is needed. resolveToken and isUnverifiedSwap
// stay real, so the decision under test is the shipped one.
const realDex = require('../lib/dex');
const dexPath = require.resolve('../lib/dex');
require.cache[dexPath] = {
  id: dexPath,
  filename: dexPath,
  loaded: true,
  exports: {
    ...realDex,
    quoteSwap: async ({ amountIn, tokenIn, tokenOut }) => ({
      amountOut: amountIn * 100n,
      amountOutMin: amountIn * 99n,
      feeAmount: 0n,
      feeBps: 30,
      slippageBps: 100,
      inIsNative: tokenIn === null,
      outIsNative: tokenOut === null,
    }),
  },
};

// Execution is the thing that must not happen without the secret. Counted here.
let executed = 0;
const realEngine = require('../lib/engine');
const enginePath = require.resolve('../lib/engine');
require.cache[enginePath] = {
  id: enginePath,
  filename: enginePath,
  loaded: true,
  exports: {
    ...realEngine,
    executeSwapPlan: async () => {
      executed += 1;
      return { ok: true, txHash: '0xabc', explorerUrl: 'https://explorer.test/tx/0xabc' };
    },
  },
};

const router = require('../lib/router');

const TG = '778899126';
const KEY = `telegram:${TG}`;
const UNVERIFIED = '0x2222222222222222222222222222222222222222';
const PIN = '482915';

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

function seed({ pin = true } = {}) {
  executed = 0;
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-trader',
        email: 'trader@example.com',
        display_name: 'Trader',
        username: 'trader',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x9999999999999999999999999999999999999999',
        unlock_pin_hash: pin ? hashPin(PIN) : null,
        password_hash: null,
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-trader', channel: 'telegram', external_id: TG, phone_e164: null },
    ],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
    transfers: [],
  });
}

async function planUnverifiedBuy(ctx, sent) {
  await router.handle(ctx, `/buy 0.01 eth of ${UNVERIFIED}`);
  const text = sent.join('\n');
  assert.match(text, /Swap plan/, `expected a plan, got:\n${text}`);
  assert.match(text, /has not verified this token/);
}

describe('chat trade of an unverified token', () => {
  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  it('asks for the secret at confirm instead of sending', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);

    sent.length = 0;
    await router.handle(ctx, 'confirm');
    assert.match(sent.join('\n'), /Reply with your PIN or account password/);
    assert.equal(executed, 0);
    assert.equal(router.pendingFlowFor(KEY).tradeSecret, true);
  });

  it('a bare secret reaches the handler and is not rewritten', async () => {
    // pendingFlowFor must say the chat is mid-flow, or WhatsApp drops the
    // unprefixed reply before the router sees it.
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    assert.deepEqual(router.normalizeInput(ctx, PIN), { text: PIN, hadPrefix: false });
  });

  it('sends only after the right PIN', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, PIN);
    assert.equal(executed, 1);
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('a wrong secret cancels the trade and sends nothing', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');

    sent.length = 0;
    await router.handle(ctx, '000000');
    assert.equal(executed, 0);
    assert.match(sent.join('\n'), /Trade cancelled\. Nothing was sent\./);
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('confirm again does not count as the secret', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 0);
    assert.equal(router.pendingFlowFor(KEY).tradeSecret, true);
  });

  it('cancel drops the plan', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, 'cancel');
    assert.equal(executed, 0);
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('with no PIN or password on the account, nothing is sent', async () => {
    seed({ pin: false });
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');

    sent.length = 0;
    await router.handle(ctx, '123456');
    assert.equal(executed, 0);
    assert.match(sent.join('\n'), /Set a PIN on the site first/);
  });
});

describe('chat trade of FLZ', () => {
  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  it('confirms without a secret, as before', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.01 eth of FLZ');
    assert.doesNotMatch(sent.join('\n'), /has not verified/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 1);
  });
});

describe('isUnverifiedSwap', () => {
  const { isUnverifiedSwap, resolveToken } = realDex;

  it('passes native, WETH and FLZ', () => {
    const weth = resolveToken('WETH', 'giwa_sepolia');
    const flz = resolveToken('FLZ', 'giwa_sepolia');
    assert.equal(isUnverifiedSwap([null, flz], 'giwa_sepolia'), false);
    assert.equal(isUnverifiedSwap([flz.toLowerCase(), null], 'giwa_sepolia'), false);
    assert.equal(isUnverifiedSwap([null, weth], 'giwa_sepolia'), false);
  });

  it('flags any other contract on either side', () => {
    assert.equal(isUnverifiedSwap([null, UNVERIFIED], 'giwa_sepolia'), true);
    assert.equal(isUnverifiedSwap([UNVERIFIED, null], 'giwa_sepolia'), true);
  });
});
