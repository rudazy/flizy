/**
 * A chat trade of a token Flizy has not verified is approved with the PIN on
 * flizy.app after CONFIRM, every time. The PIN is never typed in the chat.
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
// Chat never checks a PIN or a password, so a stored value only has to exist.
const { PIN_HASH_PRESENT, unlockedSession } = require('./helpers/unlockedChat');
const PASSWORD_HASH_PRESENT = 'password-hash-present';

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
// The account's real site password. Chat must refuse it even though it matches.
const PASSWORD = 'Secret1!';

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
        unlock_pin_hash: pin ? PIN_HASH_PRESENT : null,
        password_hash: PASSWORD_HASH_PRESENT,
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-trader', channel: 'telegram', external_id: TG, phone_e164: null },
    ],
    link_codes: [],
    users: [],
    sessions: pin ? [unlockedSession('acc-trader', 'telegram', TG)] : [],
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
  const { pollApprovals } = require('../lib/chatApprovals');
  const approvals = () => fake.db.tables.chat_approvals || [];
  const notices = () => (fake.db.tables.notifications || []).map((n) => n.body).join('\n');

  /** What the approval page does on a right PIN. */
  function approveOnPage() {
    const row = approvals().find((r) => !r.approved_at && !r.cancelled_at);
    assert.ok(row, 'an open approval');
    row.approved_at = new Date().toISOString();
  }

  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  it('CONFIRM sends a PIN link instead of sending, and asks for no PIN in chat', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);

    sent.length = 0;
    await router.handle(ctx, 'confirm');
    const text = sent.join('\n');
    assert.match(text, /Approve with your PIN on Flizy: https?:\/\/\S+\/a\/[A-Za-z0-9_-]{16,}/);
    assert.doesNotMatch(text, /Reply with your unlock PIN/);
    assert.equal(executed, 0);
    assert.equal(approvals().length, 1);
    assert.equal(approvals()[0].kind, 'plan');
    assert.match(approvals()[0].summary.title, /Approve a trade/);
  });

  it('CONFIRM again sends the same link, not a second approval', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    const first = sent[sent.length - 1];
    await router.handle(ctx, 'confirm');
    assert.equal(sent[sent.length - 1], first);
    assert.equal(approvals().length, 1);
  });

  it('a PIN typed into the chat approves nothing', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, PIN);
    await router.handle(ctx, PASSWORD);
    await pollApprovals();
    assert.equal(executed, 0);
    assert.equal(approvals()[0].approved_at || null, null);
  });

  it('runs once the page approves it, and only once', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    approveOnPage();
    await pollApprovals();
    await pollApprovals();
    assert.equal(executed, 1);
    assert.ok(approvals()[0].consumed_at, 'marked consumed');
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('a pause on the page drops the plan and says so in the chat', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    approvals()[0].cancelled_at = new Date().toISOString();
    await pollApprovals();
    assert.equal(executed, 0);
    assert.equal(router.pendingFlowFor(KEY).send, false);
    assert.match(notices(), /Not approved, so nothing was sent\./);
  });

  it('cancel drops the plan and withdraws its link', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await planUnverifiedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, 'cancel');
    assert.equal(router.pendingFlowFor(KEY).send, false);
    assert.ok(approvals()[0].cancelled_at, 'the link now reads as replaced');
    approvals()[0].approved_at = new Date().toISOString();
    await pollApprovals();
    assert.equal(executed, 0);
  });

  it('with no PIN on the account, the trade is refused before a plan exists', async () => {
    seed({ pin: false });
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, `/buy 0.01 eth of ${UNVERIFIED}`);
    const text = sent.join('\n');
    assert.doesNotMatch(text, /Swap plan/);
    assert.match(text, /Set an unlock PIN on the site first: \S+\/dashboard\/account/);
    assert.equal(router.pendingFlowFor(KEY).send, false);
    assert.equal(executed, 0);
  });
});

describe('chat trade of FLZ', () => {
  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  it('confirms without a PIN link, as before', async () => {
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
