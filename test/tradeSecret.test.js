/**
 * Chat trades: a token Flizy has not verified is refused outright. A verified
 * trade is a plain CONFIRM at any size or direction: on testnet a trade takes
 * no PIN, since what it buys or sells lands back in the same wallet.
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

const router = require('../lib/router');

const TG = '778899126';
const KEY = `telegram:${TG}`;
const UNVERIFIED = '0x2222222222222222222222222222222222222222';

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
        assert.equal(executed, 0);
      });
    }
  }
});

describe('chat trade of FLZ', () => {
  beforeEach(() => {
    router.discardPendingFlows(KEY);
  });

  it('confirms without a PIN link at any size', async () => {
    seed();
    const sent = [];
    const ctx = ctxFor(sent);
    // A hundred times the quick-send amount.
    await router.handle(ctx, '/buy 0.5 eth of FLZ');
    assert.match(sent.join('\n'), /Swap plan/);
    assert.doesNotMatch(sent.join('\n'), /has not verified|PIN/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 1);
    assert.equal((fake.db.tables.chat_approvals || []).length, 0);
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

  it('stays a plain CONFIRM however many swaps came before', async () => {
    seed();
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    for (let i = 0; i < 10; i += 1) {
      fake.db.tables.transfers.push({ id: `s${i}`, account_id: 'acc-trader', kind: 'swap', status: 'confirmed', created_at: recent });
    }
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.01 eth of FLZ');
    assert.doesNotMatch(sent.join('\n'), /PIN/);
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 1);
  });

  it('a locked chat still cannot trade', async () => {
    seed();
    fake.db.tables.sessions = [];
    const sent = [];
    const ctx = ctxFor(sent);
    await router.handle(ctx, '/buy 0.01 eth of FLZ');
    await router.handle(ctx, 'confirm');
    assert.equal(executed, 0);
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

describe('chat trade on Ammora', () => {
  it('is a plain CONFIRM too: no PIN set needed, no approval link', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'router.js'), 'utf8');
    const start = src.indexOf('async function handleAmmoraTrade(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 1));
    assert.doesNotMatch(body, /unlock_pin_hash|tierApprovalNote|needsApproval: true/);
    assert.match(body, /needsApproval: false/);
  });
});
