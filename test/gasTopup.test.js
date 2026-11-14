/**
 * Gas paid for wallets through their EntryPoint deposit, on both sides
 * (lib/gasTopup.js and web/lib/gasTopup.ts), with the same inputs.
 *
 * Covers: off unless GAS_TOPUP_ENABLED is exactly true, on needs a key of its
 * own (never PRIVATE_KEY); the per-wallet daily cap, counting pending and sent
 * top-ups of the last 24 hours only; a row written before anything is sent; a
 * refused broadcast marked failed, an unanswered one kept as sent; a key out
 * of ETH tops up nothing; the reserve a covered wallet keeps back for gas is
 * zero; and both executors top up before their funds check, only when on.
 *
 * Run: node --test test/gasTopup.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const bot = require('../lib/gasTopup');
let web;
before(async () => {
  process.env.WALLET_DERIVATION_SECRET = process.env.WALLET_DERIVATION_SECRET || 'x'.repeat(40);
  web = await import('../web/lib/gasTopup.ts');
});
const sides = () => [bot, web];

const KEY = ethers.Wallet.createRandom();
const OPS = ethers.Wallet.createRandom();
const WALLET = ethers.getAddress('0x' + 'ab'.repeat(20));
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const ON = { GAS_TOPUP_ENABLED: 'true', GAS_TOPUP_PRIVATE_KEY: KEY.privateKey, PRIVATE_KEY: OPS.privateKey };
const quiet = { warn() {}, info() {} };

/** $3,000 ETH: 1e14 wei is $0.30. */
const WEI_30C = 10n ** 14n;

describe('settings', () => {
  it('off unless exactly true; on needs a key that is not the ops key', () => {
    for (const m of sides()) {
      assert.equal(m.topupConfig({}).enabled, false);
      assert.equal(m.topupConfig({ ...ON, GAS_TOPUP_ENABLED: 'yes' }).enabled, false);
      assert.throws(() => m.topupConfig({ GAS_TOPUP_ENABLED: 'true' }), /needs GAS_TOPUP_PRIVATE_KEY/);
      assert.throws(() => m.topupConfig({ ...ON, PRIVATE_KEY: KEY.privateKey }), /must not be PRIVATE_KEY/);
      assert.throws(() => m.topupConfig({ ...ON, GAS_TOPUP_PRIVATE_KEY: 'nope' }), /not a private key/);
      const c = m.topupConfig(ON);
      assert.deepEqual([c.enabled, c.address, c.walletDailyCap, c.ethUsd], [true, KEY.address, 500_000n, 3_000_000_000n]);
    }
  });

  it('a quarter above the shortfall, priced at the testnet rate, rounded up', () => {
    for (const m of sides()) {
      assert.equal(m.topupAmountWei(100n), 125n);
      assert.equal(m.topupAmountWei(1n), 2n);
      assert.equal(m.weiToUsdMicro(WEI_30C, 3_000_000_000n), 300_000n);
      assert.equal(m.weiToUsdMicro(1n, 3_000_000_000n), 1n);
    }
  });
});

describe('the daily cap', () => {
  const hourAgo = () => new Date(Date.now() - 3600e3).toISOString();
  const rows = () => [
    { wallet: WALLET.toLowerCase(), usd_micro: '200000', status: 'sent', created_at: hourAgo() },
    { wallet: WALLET.toLowerCase(), usd_micro: '100000', status: 'pending', created_at: hourAgo() },
    // Not counted: failed, older than a day, another wallet.
    { wallet: WALLET.toLowerCase(), usd_micro: '900000', status: 'failed', created_at: hourAgo() },
    { wallet: WALLET.toLowerCase(), usd_micro: '900000', status: 'sent', created_at: new Date(Date.now() - 25 * 3600e3).toISOString() },
    { wallet: '0x' + 'cd'.repeat(20), usd_micro: '900000', status: 'sent', created_at: hourAgo() },
  ];

  it('counts pending and sent top-ups of the last 24 hours for this wallet only', async () => {
    for (const m of sides()) {
      assert.equal(await m.toppedUpToday(createFakeSupabase({ gas_topups: rows() }).client, WALLET), 300_000n);
    }
  });

  it('covers a shortfall that fits under $0.50, not one that would pass it, and nothing when off', async () => {
    for (const m of sides()) {
      const supabase = createFakeSupabase({ gas_topups: rows() }).client;
      // $0.30 so far. 1.6e13 wei x 1.25 = 2e13 wei = $0.06: fits. 1.6e14 x 1.25 = $0.60: does not.
      assert.equal(await m.topupWouldCover({ supabase, wallet: WALLET, shortfallWei: 16n * 10n ** 12n, env: ON }), true);
      assert.equal(await m.topupWouldCover({ supabase, wallet: WALLET, shortfallWei: 16n * 10n ** 13n, env: ON }), false);
      assert.equal(await m.topupWouldCover({ supabase, wallet: WALLET, shortfallWei: 1n, env: {} }), false);
    }
  });
});

describe('a top-up', () => {
  /** A chain whose node answers each broadcast as `broadcast` says. */
  function chain({ keyBalance = 10n ** 18n, broadcast = 'ok', receipt = { status: 1, blockNumber: 77 } } = {}) {
    const calls = { broadcast: 0 };
    return {
      calls,
      provider: {
        getFeeData: async () => ({ maxFeePerGas: 10n ** 9n, gasPrice: 10n ** 9n }),
        getBalance: async () => keyBalance,
        broadcastTransaction: async () => {
          calls.broadcast += 1;
          if (broadcast === 'rejected') throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
          if (broadcast === 'unknown') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        },
        waitForTransaction: async () => receipt,
      },
    };
  }
  const signer = { address: KEY.address, populateTransaction: async (tx) => tx, signTransaction: async () => '0x' + 'ab'.repeat(40) };
  const hash = ethers.keccak256('0x' + 'ab'.repeat(40));
  const run = (m, supabase, c, extra = {}) =>
    m.topUpGasDeposit({ supabase, provider: c.provider, entryPoint: ENTRY_POINT, wallet: WALLET, accountId: null, shortfallWei: 8n * 10n ** 12n, env: ON, log: quiet, signer, ...extra });

  it('records the row first, deposits, and says so once mined', async () => {
    for (const m of sides()) {
      const fake = createFakeSupabase({ gas_topups: [] });
      const c = chain();
      const out = await run(m, fake.client, c);
      assert.deepEqual(out, { ok: true, amountWei: 10n ** 13n, txHash: hash, blockNumber: 77 });
      const row = fake.db.tables.gas_topups[0];
      assert.deepEqual([row.wallet, row.amount_wei, row.usd_micro, row.status, row.tx_hash], [WALLET.toLowerCase(), String(10n ** 13n), '30000', 'sent', hash]);
      assert.equal(c.calls.broadcast, 1);
    }
  });

  it('off, nothing needed, over the cap, or a key out of ETH: no row and nothing sent', async () => {
    for (const m of sides()) {
      const cases = [
        [{ env: {} }, chain(), 'off'],
        [{ shortfallWei: 0n }, chain(), 'none needed'],
        [{ shortfallWei: 10n ** 15n }, chain(), 'daily cap reached'],
        [{}, chain({ keyBalance: 1n }), 'the top-up key is out of ETH'],
      ];
      for (const [extra, c, reason] of cases) {
        const fake = createFakeSupabase({ gas_topups: [] });
        const out = await run(m, fake.client, c, extra);
        assert.deepEqual(out, { ok: false, reason }, reason);
        assert.equal(fake.db.tables.gas_topups.length, 0, reason);
        assert.equal(c.calls.broadcast, 0, reason);
      }
    }
  });

  it('a refused broadcast is marked failed and stops counting; no answer stays sent and counts', async () => {
    for (const m of sides()) {
      const refused = createFakeSupabase({ gas_topups: [] });
      const r = await run(m, refused.client, chain({ broadcast: 'rejected' }));
      assert.equal(r.ok, false);
      assert.match(r.reason, /refused by the node/);
      assert.equal(refused.db.tables.gas_topups[0].status, 'failed');
      assert.equal(await m.toppedUpToday(refused.client, WALLET), 0n);

      const silent = createFakeSupabase({ gas_topups: [] });
      const s = await run(m, silent.client, chain({ broadcast: 'unknown' }));
      assert.deepEqual(s, { ok: false, reason: 'no answer from the node' });
      assert.deepEqual([silent.db.tables.gas_topups[0].status, silent.db.tables.gas_topups[0].tx_hash], ['sent', hash]);
      assert.equal(await m.toppedUpToday(silent.client, WALLET), 30_000n);
    }
  });

  it('a deposit that reverts is marked failed', async () => {
    for (const m of sides()) {
      const fake = createFakeSupabase({ gas_topups: [] });
      const out = await run(m, fake.client, chain({ receipt: { status: 0, blockNumber: 78 } }));
      assert.deepEqual(out, { ok: false, reason: 'the deposit reverted' });
      assert.equal(fake.db.tables.gas_topups[0].status, 'failed');
    }
  });
});

describe('the executors', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('both top up before the funds check, only when the switch is on, once per call', () => {
    for (const rel of ['lib/gatorExecute.js', 'web/lib/gatorExecute.ts']) {
      const src = read(rel);
      const body = src.slice(src.indexOf('async function executeGatorCall('));
      const topup = body.indexOf('await topUpGasDeposit(');
      const check = body.indexOf("throw new GatorExecError('INSUFFICIENT_GAS_FUNDS'");
      assert.ok(topup > 0 && topup < check, `${rel}: top-up before the funds check`);
      assert.ok(body.slice(0, topup).includes('if (shortfall > 0n && !toppedUp && topupOn()) {'), `${rel}: only when on, once`);
    }
  });

  it('a wallet the top-up covers keeps nothing back for gas; off, it keeps its usual reserve', async () => {
    const { createFakeSupabase: make, mockSupabaseModule } = require('./helpers/fakeSupabase');
    const fake = make({ gas_topups: [] });
    mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });
    const { gatorGasReserveWei } = require('../lib/gatorExecute');
    const provider = {
      // 0.01 gwei, near GIWA Sepolia's usual: the prefund then fits under the $0.50 cap.
      getFeeData: async () => ({ maxFeePerGas: 10n ** 7n, maxPriorityFeePerGas: 10n ** 6n }),
      call: async () => ethers.toBeHex(0n, 32),
    };
    const saved = { ...process.env };
    try {
      for (const k of ['GAS_TOPUP_ENABLED', 'GAS_TOPUP_PRIVATE_KEY']) delete process.env[k];
      const usual = await gatorGasReserveWei(provider, WALLET);
      assert.ok(usual > 0n);
      Object.assign(process.env, ON);
      assert.equal(await gatorGasReserveWei(provider, WALLET), 0n);
    } finally {
      for (const k of Object.keys(ON)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
