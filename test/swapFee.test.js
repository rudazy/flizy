/**
 * The swap fee in the fee ledger (Phase 0g): lib/swapFee.js, web/lib/swapFee.ts,
 * the chat swap executor, the site swap route and the reconciler.
 *
 * Covers: FeeTaken is read only from the fee router, for the wallet that swapped;
 * its token names the asset (ETH for the zero address, FLZ, a listed token) and
 * a token Flizy does not list is left out; a landed swap's fee is recorded once,
 * charged, kind 'swap', priced (a listed token from its own ETH pool), with the
 * gas Flizy paid only when the top-up funded a smart account; a swap that did
 * not land, or has no row, records nothing; the site records the same row as
 * the bot; and the executor, the route and the reconciler record it.
 *
 * Run: node --test test/swapFee.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

process.env.WALLET_DERIVATION_SECRET = process.env.WALLET_DERIVATION_SECRET || 'x'.repeat(40);

const SF = require('../lib/swapFee');
const { getDexConfig } = require('../lib/dex');
const { listedBySymbol } = require('../lib/listedTokens');
let WSF;
before(async () => {
  WSF = await import('../web/lib/swapFee.ts');
});

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const dex = getDexConfig('giwa_sepolia');
const ROUTER = ethers.getAddress(dex.feeRouter);
const FLZ = ethers.getAddress(dex.flz);
const TUSD = ethers.getAddress(listedBySymbol('TUSD').address);
const IZY = listedBySymbol('IZY');
const WALLET = ethers.getAddress('0x' + 'ab'.repeat(20));
const OTHER = ethers.getAddress('0x' + 'cd'.repeat(20));
const HASH = '0x' + '12'.repeat(32);
const quiet = { warn() {}, info() {}, error() {} };
const EV = new ethers.Interface(['event FeeTaken(address indexed payer, address token, uint256 amount)']);
const feeLog = (token, amount, { payer = WALLET, address = ROUTER } = {}) => {
  const e = EV.encodeEventLog('FeeTaken', [payer, token, amount]);
  return { address, topics: e.topics, data: e.data };
};
const receipt = (logs, status = 1) => ({ status, hash: HASH, logs });
const PAIR = new ethers.Interface([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);
/** IZY's pool: 1 WETH per 10,000 IZY, so $0.30 an IZY at $3,000. */
const provider = {
  getFeeData: async () => ({ maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n }),
  call: async ({ data }) => {
    const fn = PAIR.parseTransaction({ data });
    if (fn.name === 'token0') return PAIR.encodeFunctionResult('token0', [IZY.address]);
    return PAIR.encodeFunctionResult('getReserves', [10_000n * 10n ** 18n, 10n ** 18n, 0]);
  },
};
const db = () => createFakeSupabase({ fee_ledger: [] });

describe('reading the fee from a swap', () => {
  it('only from the fee router, and for the wallet that swapped', () => {
    const logs = [feeLog(ethers.ZeroAddress, 9n), feeLog(TUSD, 5n, { payer: OTHER }), feeLog(TUSD, 7n, { address: OTHER })];
    assert.deepEqual(SF.feeTakenFrom(receipt(logs), ROUTER, WALLET), [{ payer: WALLET, token: ethers.ZeroAddress, amount: 9n }]);
    assert.equal(SF.feeTakenFrom(receipt(logs), ROUTER).length, 2);
  });

  it('names the asset: ETH, FLZ, a listed token, or nothing for a token Flizy does not list', () => {
    assert.equal(SF.feeAssetOf(ethers.ZeroAddress, 'giwa_sepolia'), 'ETH');
    assert.equal(SF.feeAssetOf(FLZ, 'giwa_sepolia'), 'FLZ');
    assert.equal(SF.feeAssetOf(TUSD, 'giwa_sepolia'), 'TUSD');
    assert.equal(SF.feeAssetOf(OTHER, 'giwa_sepolia'), null);
  });
});

describe('recording it', () => {
  const record = (store, rcpt, over = {}) =>
    SF.recordSwapFee({ supabase: store.client, provider, receipt: rcpt, transferId: 't-1', accountId: 'acct-1', payer: WALLET, chainKey: 'giwa_sepolia', env: {}, log: quiet, ...over });

  it('a landed swap: once, charged, kind swap, priced, with the wallet having paid its gas', async () => {
    const store = db();
    assert.equal(await record(store, receipt([feeLog(ethers.ZeroAddress, 3n * 10n ** 14n)])), 'recorded');
    assert.equal(await record(store, receipt([feeLog(ethers.ZeroAddress, 3n * 10n ** 14n)])), 'duplicate');
    const rows = store.db.tables.fee_ledger;
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.deepEqual(
      [r.source_kind, r.source_id, r.account_id, r.kind, r.asset, r.fee_units, r.fee_usd_micro, r.state, r.tx_hash, r.gas_paid_wei],
      ['transfer', 't-1', 'acct-1', 'swap', 'ETH', String(3n * 10n ** 14n), '900000', 'charged', HASH, '0']
    );
    assert.ok(r.settled_at);
  });

  it('a token Flizy does not list, a swap that did not land, or no row: nothing recorded', async () => {
    const store = db();
    assert.equal(await record(store, receipt([feeLog(OTHER, 5n)])), 'unlisted token');
    assert.equal(await record(store, receipt([feeLog(TUSD, 5n)], 0)), 'no swap');
    assert.equal(await record(store, receipt([feeLog(TUSD, 5n)]), { transferId: null }), 'no swap');
    assert.equal(await record(store, receipt([])), 'no fee');
    assert.equal(store.db.tables.fee_ledger.length, 0);
  });

  it('a ledger that cannot be written: logged, never thrown', async () => {
    const broken = { from: () => ({ upsert: () => ({ select: async () => ({ data: null, error: { message: 'down' } }) }) }) };
    assert.equal(await SF.recordSwapFee({ supabase: broken, provider, receipt: receipt([feeLog(TUSD, 5n)]), transferId: 't-1', accountId: 'a', payer: WALLET, chainKey: 'giwa_sepolia', env: {}, log: quiet }), 'failed');
  });
});

describe('the site records the same', () => {
  const site = (store, rcpt, over = {}) =>
    WSF.recordSwapFee({ supabase: store.client, provider, receipt: rcpt, transferId: 't-1', accountId: 'acct-1', payer: WALLET, gator: null, dex: { feeRouter: ROUTER, flz: FLZ, pair: dex.pair }, env: {}, ...over });

  it('the same row as the bot for the same swap', async () => {
    const bot = db();
    const web = db();
    const rcpt = receipt([feeLog(TUSD, 30_000n)]);
    await SF.recordSwapFee({ supabase: bot.client, provider, receipt: rcpt, transferId: 't-1', accountId: 'acct-1', payer: WALLET, chainKey: 'giwa_sepolia', env: {}, log: quiet });
    assert.equal(await site(web, rcpt), 'recorded');
    const pick = (r) => [r.kind, r.asset, r.fee_units, r.fee_usd_micro, r.price_usd_micro, r.state, r.tx_hash, r.gas_paid_wei];
    assert.deepEqual(pick(web.db.tables.fee_ledger[0]), pick(bot.db.tables.fee_ledger[0]));
  });

  it('a listed token is priced from its own ETH pool', async () => {
    const store = db();
    // 0.3% of 1,000 IZY at $0.30 = 3 IZY = $0.90.
    assert.equal(await site(store, receipt([feeLog(IZY.address, 3n * 10n ** 18n)])), 'recorded');
    const r = store.db.tables.fee_ledger[0];
    assert.deepEqual([r.asset, r.price_usd_micro, r.fee_usd_micro, r.price_source], ['IZY', '300000', '900000', 'Flizy IZY/WETH pool']);
  });

  it('a token Flizy does not list is left out', async () => {
    const store = db();
    assert.equal(await site(store, receipt([feeLog(OTHER, 5n)])), 'unlisted token');
    assert.equal(store.db.tables.fee_ledger.length, 0);
  });
});

describe('where it is recorded', () => {
  it('the chat swap executor, after the swap lands, for the wallet that swapped', () => {
    const src = read('lib/engine/executeSwap.js');
    const at = src.indexOf('await recordSwapFee({');
    assert.ok(at > src.indexOf('await logReceipt(transferRow?.id, { ok: true, txHash: result.txHash });'));
    assert.match(src.slice(at, at + 300), /payer: walletAddr,\s+gator: viaGator \? walletAddr : null,/);
  });

  it('the site swap route, after the swap is confirmed', () => {
    const src = read('web/app/api/swap/execute/route.ts');
    const at = src.indexOf('await recordSwapFee({');
    assert.ok(at > src.indexOf(".update({ status: 'confirmed', tx_hash: result.txHash })"));
    assert.match(src.slice(at, at + 300), /gator: viaGator \? walletAddr : null,/);
  });

  it('the reconciler, for a swap it finds landed, and only a swap', async () => {
    const { runReconcileTick, resetFlaggedCursors, SETTLE_AFTER_MS } = require('../lib/reconcile');
    const NOW = Date.now();
    const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
    const row = (id, kind) => ({ id, account_id: 'acct-1', user_id: 'u1', status: 'submitted', tx_hash: '0x' + id.padStart(64, '0'), kind, amount_eth: '1', asset: 'ETH', created_at: new Date(NOW - SETTLE_AFTER_MS - 1000).toISOString() });
    const fake = createFakeSupabase({ transfers: [row('a1', 'swap'), row('b2', 'transfer')], limit_orders: [], claim_hold_attempts: [], claims: [], fee_ledger: [] });
    resetFlaggedCursors();
    const recorded = [];
    await runReconcileTick({
      supabase: fake.client,
      now: NOW,
      entryPoint: EP,
      gatorOf: () => WALLET,
      userOpSucceeded: () => true,
      provider: { getTransactionReceipt: async () => ({ status: 1, to: OTHER, logs: [] }) },
      alertAdmins: async () => {},
      notifyAccount: async () => {},
      markRequestPaid: async () => {},
      releaseRequestProcessing: async () => {},
      creditBack: async () => {},
      recordSwapFee: async (d, r) => recorded.push(r.id),
    });
    assert.deepEqual(recorded, ['a1']);
    const src = read('lib/reconcile.js');
    assert.match(src, /if \(outcome === 'success' && String\(row\.kind \|\| ''\)\.toLowerCase\(\) === 'swap'\) await d\.recordSwapFee\(d, row\);/);
  });
});
