/**
 * What each money path does with the executor's outcomes (bot side).
 *
 * A refusal (nothing sent) must release what was reserved, mark the record
 * failed or refused, and say "nothing was sent". An unknown outcome (broadcast,
 * no answer) must keep the record 'submitted' with its tx hash, release
 * nothing, reopen nothing, and say it is still confirming. The executor is
 * scripted here; its own behaviour is in test/gatorExecuteHardening.test.js.
 *
 * Run: node --test test/executorOutcomes.test.js
 */

process.env.ENFORCE_CREDIT = 'true';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const realGator = require('../lib/gatorExecute');
const { GatorExecError } = realGator;
const HASH = '0x' + 'ab'.repeat(32);

/** The scripted executor: replaced per test. */
let script;
const calls = [];
const gatorPath = require.resolve('../lib/gatorExecute');
require.cache[gatorPath].exports = {
  ...realGator,
  gatorGasReserveWei: async () => 0n,
  executeGatorCall: async (args) => {
    calls.push(args);
    return script(args);
  },
};

const escrowPath = require.resolve('../lib/escrowWallet');
require.cache[escrowPath] = {
  id: escrowPath,
  filename: escrowPath,
  loaded: true,
  exports: {
    getEscrowWallet: () => ({ address: '0x4444444444444444444444444444444444444444' }),
    assertEscrowSolvent: async () => ({ ok: true, balanceEth: '1', liabilityEth: '0', pendingCount: 0 }),
  },
};

const { predictGatorAddress } = require('../lib/gatorAccount');
const { executeNativeSend, executeTokenSend } = require('../lib/engine/executeTransfer');
const { executeClaimHold } = require('../lib/engine/executeClaim');
const { runLimitOrderTick } = require('../lib/limitOrders');

const ACCOUNT = 'acct-outcomes';
const USER = 'user-outcomes';
const TO = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

const ok = async (args) => {
  if (args.onBroadcast) await args.onBroadcast(HASH);
  return { txHash: HASH, receipt: { status: 1, blockNumber: 9 }, gator: predictGatorAddress(ACCOUNT) };
};
const unknown = async (args) => {
  if (args.onBroadcast) await args.onBroadcast(HASH);
  throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet', { submitted: true, txHash: HASH });
};
const refuse = (code) => async () => {
  throw new GatorExecError(code, 'refused');
};
const reverted = async (args) => {
  if (args.onBroadcast) await args.onBroadcast(HASH);
  throw new GatorExecError('USEROP_REVERTED', 'reverted', { txHash: HASH });
};

const provider = {
  async getNetwork() {
    return { chainId: 91342 };
  },
  async getBalance() {
    return 10n ** 18n;
  },
};

function seed(extra = {}) {
  calls.length = 0;
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: predictGatorAddress(ACCOUNT), balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
    claims: [],
    claim_hold_attempts: [],
    ...extra,
  });
}
const credit = () => Number(fake.db.tables.users[0].balance_eth);
const rows = () => fake.db.tables.transfers;

function plan(kind = 'native_transfer', amount = '0.4') {
  return {
    intent: 'SEND',
    expiresAt: Date.now() + 60_000,
    paymentRequestId: kind === 'native_transfer' ? null : undefined,
    input: { amount, asset: kind === 'native_transfer' ? 'ETH' : 'FLZ', recipientLabel: 'john', tokenAddress: kind === 'native_transfer' ? null : TOKEN },
    route: { kind, toAddress: TO, fromAddress: TO, tokenAddress: kind === 'native_transfer' ? null : TOKEN },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
  };
}

const send = () => executeNativeSend({ plan: plan(), provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });

beforeEach(() => seed());

describe('chat native send', () => {
  it('confirmed: the row has the hash and the credit stays spent', async () => {
    script = ok;
    const r = await send();
    assert.equal(r.ok, true);
    assert.equal(rows()[0].status, 'confirmed');
    assert.equal(rows()[0].tx_hash, HASH);
    assert.equal(Number(credit().toFixed(10)), 0.6);
  });

  it('the hash is on the row before the broadcast (onBroadcast)', async () => {
    let atBroadcast;
    script = async (args) => {
      await args.onBroadcast(HASH);
      atBroadcast = { ...rows()[0] };
      return ok({});
    };
    await send();
    assert.equal(atBroadcast.status, 'submitted');
    assert.equal(atBroadcast.tx_hash, HASH);
  });

  it('unknown outcome: submitted, row stays submitted with its hash, credit not released, pending copy', async () => {
    script = unknown;
    const r = await send();
    assert.equal(r.ok, false);
    assert.equal(r.submitted, true);
    assert.equal(rows()[0].status, 'submitted');
    assert.equal(rows()[0].tx_hash, HASH);
    assert.equal(Number(credit().toFixed(10)), 0.6, 'reservation must NOT come back');
    assert.match(r.error, /^Your payment is pending/);
    assert.doesNotMatch(r.error, /not sent|nothing was sent/i);
  });

  it('refused (would revert): not submitted, row failed, credit released, clean copy', async () => {
    script = refuse('WOULD_REVERT');
    const r = await send();
    assert.equal(r.submitted, false);
    assert.equal(rows()[0].status, 'failed');
    assert.equal(Number(credit().toFixed(10)), 1);
    assert.equal(r.error, 'This would fail right now, so nothing was sent.');
  });

  it('refused (not enough for the network fee): its own copy', async () => {
    script = refuse('INSUFFICIENT_GAS_FUNDS');
    const r = await send();
    assert.equal(r.submitted, false);
    assert.equal(r.error, 'Not enough ETH to cover the network fee, so nothing was sent.');
    assert.equal(Number(credit().toFixed(10)), 1);
  });

  it('the payment request id is on the row, for the reconciler', async () => {
    script = unknown;
    const p = plan();
    p.paymentRequestId = '11111111-1111-4111-8111-111111111111';
    await executeNativeSend({ plan: p, provider, chain, user: { id: USER, balance_eth: 1 }, supabase: fake.client });
    assert.equal(rows()[0].payment_request_id, p.paymentRequestId);
  });
});

describe('chat token send', () => {
  it('unknown outcome keeps the row submitted', async () => {
    script = unknown;
    const tokenProvider = {
      ...provider,
      async call(tx) {
        const { ethers } = require('ethers');
        const sel = String(tx.data).slice(0, 10);
        const iface = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
        if (sel === iface.getFunction('decimals').selector) return iface.encodeFunctionResult('decimals', [18]);
        return iface.encodeFunctionResult('balanceOf', [10n ** 24n]);
      },
    };
    const r = await executeTokenSend({ plan: plan('erc20_transfer', '5'), provider: tokenProvider, chain, user: { id: USER }, supabase: fake.client });
    assert.equal(r.submitted, true, JSON.stringify(r));
    assert.equal(rows()[0].status, 'submitted');
    assert.equal(rows()[0].tx_hash, HASH);
  });
});

describe('claim hold', () => {
  const hold = () =>
    executeClaimHold({
      fromAccountId: ACCOUNT,
      fromWaSender: '2348000000000',
      toWaHint: '2348099999999',
      amountEth: '0.01',
      asset: 'ETH',
      provider,
      chain,
      escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    });
  const attempt = () => fake.db.tables.claim_hold_attempts[0];

  it('landed: one claim, attempt held and linked to it', async () => {
    script = ok;
    const r = await hold();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fake.db.tables.claims.length, 1);
    assert.equal(attempt().status, 'held');
    assert.equal(attempt().claim_id, fake.db.tables.claims[0].id);
    assert.equal(attempt().hold_tx_hash, HASH);
  });

  it('intent is written before signing, hash at broadcast', async () => {
    let before;
    let atBroadcast;
    script = async (args) => {
      before = { ...attempt() };
      await args.onBroadcast(HASH);
      atBroadcast = { ...attempt() };
      return ok({});
    };
    await hold();
    assert.equal(before.status, 'sending');
    assert.equal(before.hold_tx_hash ?? null, null);
    assert.deepEqual(before.claim_args.recipient, { kind: 'phone', phone: '2348099999999' });
    assert.equal(atBroadcast.status, 'submitted');
    assert.equal(atBroadcast.hold_tx_hash, HASH);
  });

  it('unknown outcome: no claim yet, attempt stays submitted with the hash, still-confirming copy', async () => {
    script = unknown;
    const r = await hold();
    assert.equal(r.ok, false);
    assert.equal(r.submitted, true);
    assert.equal(fake.db.tables.claims.length, 0);
    assert.equal(attempt().status, 'submitted');
    assert.equal(attempt().hold_tx_hash, HASH);
    assert.match(r.error, /^Sent, and still confirming/);
  });

  it('refused before broadcast: attempt refused, no claim, clean copy', async () => {
    script = refuse('WOULD_REVERT');
    const r = await hold();
    assert.equal(r.submitted, false);
    assert.equal(attempt().status, 'refused');
    assert.equal(fake.db.tables.claims.length, 0);
    assert.equal(r.error, 'This would fail right now, so nothing was sent.');
  });

  it('mined and reverted: attempt failed', async () => {
    script = reverted;
    const r = await hold();
    assert.equal(r.submitted, false);
    assert.equal(attempt().status, 'failed');
  });

  it('landed but the claim row could not be written: attempt stays submitted for the reconciler', async () => {
    script = ok;
    // The claims insert fails (database down after the hold landed).
    const realFrom = fake.client.from.bind(fake.client);
    const failing = new Proxy({}, {
      get: (_t, prop) => (prop === 'then' ? (resolve) => resolve({ data: null, error: { message: 'down' } }) : () => failing),
    });
    fake.client.from = (t) => (t === 'claims' ? failing : realFrom(t));
    const r = await hold();
    fake.client.from = realFrom;
    assert.equal(fake.db.tables.claims.length, 0);
    assert.equal(r.submitted, true);
    assert.equal(attempt().status, 'submitted');
    assert.equal(attempt().hold_tx_hash, HASH);
  });
});

describe('limit orders', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z');
  const iso = (ms) => new Date(NOW + ms).toISOString();
  function book(rowsIn) {
    fake = createFakeSupabase({
      limit_orders: rowsIn.map((r) => ({
        account_id: ACCOUNT,
        side: 'buy',
        amount_in: String(10n ** 16n),
        min_out: String(5n * 10n ** 18n),
        status: 'open',
        tx_hash: null,
        created_at: iso(-60e3),
        updated_at: iso(-60e3),
        expires_at: iso(3600e3),
        ...r,
      })),
    });
    return fake;
  }
  const deps = (executePlan) => ({
    supabase: fake.client,
    provider: {},
    chain: require('../lib/chains').getChain('giwa_sepolia'),
    now: NOW,
    quote: async () => ({ amountOut: 6n * 10n ** 18n }),
    executePlan,
    lock: async () => ({ ok: true }),
    release: async () => {},
  });

  it('unknown outcome: stays filling with its hash, not failed', async () => {
    book([{ id: 'o1' }]);
    const c = await runLimitOrderTick(
      deps(async ({ onBroadcast }) => {
        await onBroadcast(HASH);
        return { ok: false, submitted: true, txHash: HASH, error: 'Sent, and still confirming.' };
      })
    );
    const row = fake.db.tables.limit_orders[0];
    assert.equal(row.status, 'filling');
    assert.equal(row.tx_hash, HASH);
    assert.equal(c.unknown, 1);
    assert.equal(c.failed, 0);
  });

  it('refused before broadcast: failed, as before', async () => {
    book([{ id: 'o1' }]);
    await runLimitOrderTick(deps(async () => ({ ok: false, submitted: false, error: 'This would fail right now, so nothing was sent.' })));
    assert.equal(fake.db.tables.limit_orders[0].status, 'failed');
  });

  it('a stale filling order WITH a hash is left for the reconciler', async () => {
    const { FILLING_STALE_MS } = require('../lib/limitOrders');
    book([{ id: 'o1', status: 'filling', tx_hash: HASH, updated_at: iso(-FILLING_STALE_MS - 1) }]);
    const c = await runLimitOrderTick(deps(async () => ({ ok: true })));
    assert.equal(fake.db.tables.limit_orders[0].status, 'filling');
    assert.equal(c.interrupted, 0);
  });

  it('a stale filling order WITHOUT a hash still becomes failed', async () => {
    const { FILLING_STALE_MS } = require('../lib/limitOrders');
    book([{ id: 'o1', status: 'filling', tx_hash: null, updated_at: iso(-FILLING_STALE_MS - 1) }]);
    await runLimitOrderTick(deps(async () => ({ ok: true })));
    assert.equal(fake.db.tables.limit_orders[0].status, 'failed');
  });
});

describe('chat swap and accept offer', () => {
  const { executeSwapPlan } = require('../lib/engine/executeSwap');
  const { executeAcceptOfferPlan } = require('../lib/engine/executeAcceptOffer');
  const dexCfg = require('../lib/dex').getDexConfig('giwa_sepolia');

  const swapPlan = () => ({
    intent: 'SWAP',
    actor: { accountId: ACCOUNT, waSenderId: '2348000000000' },
    route: { kind: 'swap', routerAddress: dexCfg.feeRouter },
    input: { amount: '0.001', amountInWei: String(10n ** 15n), amountOutMinWei: '1', inIsNative: true, outIsNative: false, tokenOut: TOKEN, tokenOutLabel: 'FLZ' },
  });

  it('swap, unknown outcome: row stays submitted, the caller hook got the hash, still-confirming copy', async () => {
    script = unknown;
    let hooked = null;
    const r = await executeSwapPlan({ plan: swapPlan(), provider, chain, onBroadcast: (h) => { hooked = h; } });
    assert.equal(r.submitted, true, JSON.stringify(r));
    assert.equal(hooked, HASH);
    assert.equal(rows()[0].status, 'submitted');
    assert.equal(rows()[0].tx_hash, HASH);
    assert.match(r.error, /^Sent, and still confirming/);
  });

  it('swap, refused: row failed, clean copy', async () => {
    script = refuse('WOULD_REVERT');
    const r = await executeSwapPlan({ plan: swapPlan(), provider, chain });
    assert.equal(r.submitted, false);
    assert.equal(rows()[0].status, 'failed');
    assert.equal(r.error, 'This would fail right now, so nothing was sent.');
  });

  it('swap of 1,000 or more: the row holds the exact number, not the grouped display string', async () => {
    script = unknown;
    const plan = swapPlan();
    plan.input = { ...plan.input, amount: '1,000', amountInWei: String(1000n * 10n ** 18n), inIsNative: false, outIsNative: true, tokenIn: TOKEN, tokenOut: null, tokenInLabel: 'FLZ', tokenOutLabel: 'ETH' };
    await executeSwapPlan({ plan, provider, chain });
    assert.equal(rows()[0].amount_eth, '1000.0');
  });

  const offerPlan = () => ({
    intent: 'NFT_ACCEPT_OFFER',
    expiresAt: Date.now() + 60_000,
    actor: { accountId: ACCOUNT, waSenderId: '2348000000000' },
    input: { label: 'Accept offer' },
    route: {
      marketAddress: TO,
      calls: [
        { target: TOKEN, value: '0', data: '0x01' },
        { target: TO, value: '0', data: '0x02' },
      ],
    },
  });

  it('accept offer, the sale unknown: submitted, row stays submitted', async () => {
    script = async (args) => (args.onBroadcast ? unknown(args) : ok(args));
    const r = await executeAcceptOfferPlan({ plan: offerPlan(), provider, chain });
    assert.equal(r.submitted, true, JSON.stringify(r));
    assert.equal(rows()[0].status, 'submitted');
    assert.equal(calls[0].onBroadcast, undefined, 'the approval is not recorded as the sale');
    assert.equal(typeof calls[1].onBroadcast, 'function');
  });

  it('accept offer, the approval unknown: nothing sold, not submitted', async () => {
    script = unknown;
    const r = await executeAcceptOfferPlan({ plan: offerPlan(), provider, chain });
    assert.equal(r.submitted, false);
    assert.match(r.error, /Nothing was sold/);
    assert.equal(calls.length, 1, 'the sale was never sent');
  });
});

describe('a broadcast the node refused is settled at once as not sent', () => {
  const rejected = async (args) => {
    if (args.onBroadcast) await args.onBroadcast(HASH);
    throw new GatorExecError('BROADCAST_REJECTED', 'nonce too low', { txHash: HASH });
  };

  it('native send: not submitted, row failed with the hash, credit released, refusal copy', async () => {
    script = rejected;
    const r = await send();
    assert.equal(r.submitted, false);
    assert.equal(rows()[0].status, 'failed');
    assert.equal(rows()[0].tx_hash, HASH);
    assert.equal(Number(credit().toFixed(10)), 1);
    assert.equal(r.error, 'The network refused this, so nothing was sent. Try again shortly.');
  });

  it('claim hold: attempt failed, no claim', async () => {
    script = rejected;
    const r = await executeClaimHold({
      fromAccountId: ACCOUNT,
      fromWaSender: '2348000000000',
      toWaHint: '2348099999999',
      amountEth: '0.01',
      asset: 'ETH',
      provider,
      chain,
      escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    });
    assert.equal(r.submitted, false);
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'failed');
    assert.equal(fake.db.tables.claims.length, 0);
  });

  it('swap: not submitted, row failed', async () => {
    script = rejected;
    const { executeSwapPlan } = require('../lib/engine/executeSwap');
    const dexCfg = require('../lib/dex').getDexConfig('giwa_sepolia');
    const r = await executeSwapPlan({
      plan: {
        intent: 'SWAP',
        actor: { accountId: ACCOUNT, waSenderId: '2348000000000' },
        route: { kind: 'swap', routerAddress: dexCfg.feeRouter },
        input: { amount: '0.001', amountInWei: String(10n ** 15n), amountOutMinWei: '1', inIsNative: true, outIsNative: false, tokenOut: TOKEN, tokenOutLabel: 'FLZ' },
      },
      provider,
      chain,
    });
    assert.equal(r.submitted, false);
    assert.equal(rows()[0].status, 'failed');
  });
});
