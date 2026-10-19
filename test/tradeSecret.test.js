/**
 * Chat trades: a token Flizy has not verified is refused outright. A verified
 * trade is a plain CONFIRM when its price check passes (lib/priceReference.js),
 * at any size or direction, and otherwise is approved with the PIN on
 * flizy.app after CONFIRM. The PIN is never typed in the chat.
 *
 * Any token other than ETH, WETH, FLZ and the listed tokens trades against a
 * pool whoever deployed it can seed and drain. The output lands in this
 * wallet, but the ETH put in can still be taken, so chat does not trade them.
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

// The price check is stubbed: its own logic is tested in
// test/priceReference.test.js. Each call is recorded so the inputs the router
// hands it can be checked.
let priceResult = { ok: true, reason: 'in_band' };
const priceCalls = [];
const realPrice = require('../lib/priceReference');
const pricePath = require.resolve('../lib/priceReference');
require.cache[pricePath] = {
  id: pricePath,
  filename: pricePath,
  loaded: true,
  exports: {
    ...realPrice,
    swapPriceCheck: async (args) => {
      priceCalls.push(args);
      return priceResult;
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

function seed({ pin = true, price = { ok: true, reason: 'in_band' } } = {}) {
  executed = 0;
  priceResult = price;
  priceCalls.length = 0;
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

/** A FLZ buy whose price check fails, so it takes the PIN. */
async function planPinnedBuy(ctx, sent) {
  await router.handle(ctx, '/buy 0.01 eth of FLZ');
  const text = sent.join('\n');
  assert.match(text, /Swap plan/, `expected a plan, got:\n${text}`);
  assert.match(text, /The pool price is away from its recent level, or could not be checked\. After CONFIRM you approve it with your PIN/);
}

describe('chat trade that takes the PIN (price check failed)', () => {
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
    seed({ price: { ok: false, reason: 'price_moved' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await planPinnedBuy(ctx, sent);

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
    seed({ price: { ok: false, reason: 'price_moved' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await planPinnedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    const first = sent[sent.length - 1];
    await router.handle(ctx, 'confirm');
    assert.equal(sent[sent.length - 1], first);
    assert.equal(approvals().length, 1);
  });

  it('a PIN typed into the chat approves nothing', async () => {
    seed({ price: { ok: false, reason: 'price_moved' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await planPinnedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, PIN);
    await router.handle(ctx, PASSWORD);
    await pollApprovals();
    assert.equal(executed, 0);
    assert.equal(approvals()[0].approved_at || null, null);
  });

  it('runs once the page approves it, and only once', async () => {
    seed({ price: { ok: false, reason: 'price_moved' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await planPinnedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    approveOnPage();
    await pollApprovals();
    await pollApprovals();
    assert.equal(executed, 1);
    assert.ok(approvals()[0].consumed_at, 'marked consumed');
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('a pause on the page drops the plan and says so in the chat', async () => {
    seed({ price: { ok: false, reason: 'price_moved' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await planPinnedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    approvals()[0].cancelled_at = new Date().toISOString();
    await pollApprovals();
    assert.equal(executed, 0);
    assert.equal(router.pendingFlowFor(KEY).send, false);
    assert.match(notices(), /Not approved, so nothing was sent\./);
  });

  it('cancel drops the plan and withdraws its link', async () => {
    seed({ price: { ok: false, reason: 'price_moved' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await planPinnedBuy(ctx, sent);
    await router.handle(ctx, 'confirm');
    await router.handle(ctx, 'cancel');
    assert.equal(router.pendingFlowFor(KEY).send, false);
    assert.ok(approvals()[0].cancelled_at, 'the link now reads as replaced');
    approvals()[0].approved_at = new Date().toISOString();
    await pollApprovals();
    assert.equal(executed, 0);
  });

});

describe('chat trade of an unverified token', () => {
  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  for (const pin of [true, false]) {
    for (const command of [`/buy 0.01 eth of ${UNVERIFIED}`, `/sell 5 ${UNVERIFIED}`]) {
      it(`is refused before a plan exists (${command.split(' ')[0]}, ${pin ? 'with' : 'without'} a PIN)`, async () => {
        seed({ pin });
        const sent = [];
        const ctx = ctxFor(sent);
        await router.handle(ctx, command);
        const text = sent.join('\n');
        assert.doesNotMatch(text, /Swap plan/);
        assert.match(text, /Flizy only trades tokens it has verified\. This token is not one of them\./);
        assert.equal(router.pendingFlowFor(KEY).send, false);
        assert.equal((fake.db.tables.chat_approvals || []).length, 0);
        assert.equal(priceCalls.length, 0);
        assert.equal(executed, 0);
      });
    }
  }
});

describe('chat trade of FLZ', () => {
  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  it('confirms without a PIN link at any size while the price check passes', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    // A hundred times the quick-send amount.
    await router.handle(ctx, '/buy 0.5 eth of FLZ');
    assert.doesNotMatch(sent.join('\n'), /has not verified|PIN/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 1);
    assert.equal((fake.db.tables.chat_approvals || []).length, 0);
  });

  it('after four swaps in the hour, chat or site, the next one takes the PIN', async () => {
    seed();
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    for (let i = 0; i < 4; i += 1) {
      fake.db.tables.transfers.push({ id: `s${i}`, account_id: 'acc-trader', kind: 'swap', status: 'confirmed', created_at: recent });
    }
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.01 eth of FLZ');
    assert.match(sent.join('\n'), /That is 4 swaps in the last hour, so this one takes the PIN\. After CONFIRM you approve it with your PIN/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 0);
  });

  it('a sell back to ETH is a plain CONFIRM too', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/sell 500 FLZ');
    assert.doesNotMatch(sent.join('\n'), /PIN/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 1);
  });

  it('checks the FLZ pool with the plan minimum as the worst fill, at plan and again at CONFIRM', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.5 eth of FLZ');
    await router.handle(ctx, 'confirm');
    assert.equal(priceCalls.length, 2);
    const flz = realDex.resolveToken('FLZ', 'giwa_sepolia').toLowerCase();
    for (const call of priceCalls) {
      assert.equal(call.pool.token, flz);
      assert.equal(call.inIsNative, true);
      assert.equal(call.amountIn, 5n * 10n ** 17n);
      // quoteSwap is stubbed to a minimum of 99 per unit in.
      assert.equal(call.amountOutMin, 5n * 10n ** 17n * 99n);
    }
  });

  it('a price that moves while the plan waits turns CONFIRM into a PIN link', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.5 eth of FLZ');
    assert.doesNotMatch(sent.join('\n'), /PIN/);
    priceResult = { ok: false, reason: 'price_moved' };
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 0);
    assert.match(sent.join('\n'), /Approve with your PIN on Flizy: \S+\/a\//);
  });

  it('when the price check fails, CONFIRM sends a PIN link and the page approves it', async () => {
    const { pollApprovals } = require('../lib/chatApprovals');
    seed({ price: { ok: false, reason: 'no_reference' } });
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.01 eth of FLZ');
    assert.match(sent.join('\n'), /The pool price is away from its recent level, or could not be checked\. After CONFIRM you approve it with your PIN/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 0);
    assert.match(sent.join('\n'), /Approve with your PIN on Flizy: \S+\/a\//);
    fake.db.tables.chat_approvals[0].approved_at = new Date().toISOString();
    await pollApprovals();
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
