/**
 * The job that writes the reference prices (lib/priceSnapshots.js).
 *
 * Run: node --test test/priceSnapshots.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { runSnapshotTick, pruneSnapshots, KEEP_MS } = require('../lib/priceSnapshots');

const E18 = 10n ** 18n;
const CHAIN = { id: 'giwa_sepolia', chainId: 91342 };
const NOW = Date.parse('2026-10-19T12:07:00.000Z');
const A = { token: '0x' + 'a'.repeat(40), pair: '0x' + '1'.repeat(40) };
const B = { token: '0x' + 'b'.repeat(40), pair: '0x' + '2'.repeat(40) };
const WETH = '0x' + 'c'.repeat(40);

const iface = new ethers.Interface([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);

/** Pairs by address: { token, reserveToken, reserveEth }, or 'fail'. */
function provider(pairs) {
  return {
    call: async (tx) => {
      const p = pairs[String(tx.to).toLowerCase()];
      if (!p || p === 'fail') throw new Error('rpc down');
      const fn = iface.getFunction(tx.data.slice(0, 10));
      if (fn.name === 'token0') return iface.encodeFunctionResult('token0', [p.token]);
      return iface.encodeFunctionResult('getReserves', [p.reserveToken, p.reserveEth, 0]);
    },
  };
}

describe('runSnapshotTick', () => {
  it('writes one row per pool into the current bucket, in raw units', async () => {
    const fake = createFakeSupabase({ token_price_snapshots: [] });
    const out = await runSnapshotTick({
      supabase: fake.client,
      provider: provider({
        [A.pair]: { token: A.token, reserveToken: 1000n * E18, reserveEth: E18 },
        [B.pair]: { token: B.token, reserveToken: 5n * 10n ** 6n, reserveEth: 2n * E18 },
      }),
      chain: CHAIN,
      now: NOW,
      pools: [A, B],
    });
    assert.deepEqual(out, { written: 2, skipped: 0 });
    const rows = fake.db.tables.token_price_snapshots;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.chain_id, r.token, r.pair, r.bucket, r.reserve_eth, r.reserve_token]),
      [
        [91342, A.token, A.pair, '2026-10-19T12:00:00.000Z', String(E18), String(1000n * E18)],
        [91342, B.token, B.pair, '2026-10-19T12:00:00.000Z', String(2n * E18), String(5n * 10n ** 6n)],
      ]
    );
  });

  it('never adds or changes a second snapshot in the same bucket', async () => {
    const fake = createFakeSupabase({ token_price_snapshots: [] });
    const deps = (reserveEth) => ({
      supabase: fake.client,
      provider: provider({ [A.pair]: { token: A.token, reserveToken: 1000n * E18, reserveEth } }),
      chain: CHAIN,
      pools: [A],
    });
    await runSnapshotTick({ ...deps(E18), now: NOW });
    // Later in the same bucket, at a moved price: the first snapshot stands.
    await runSnapshotTick({ ...deps(50n * E18), now: NOW + 5 * 60 * 1000 });
    assert.equal(fake.db.tables.token_price_snapshots.length, 1);
    assert.equal(fake.db.tables.token_price_snapshots[0].reserve_eth, String(E18));
    // The next bucket gets its own row.
    await runSnapshotTick({ ...deps(2n * E18), now: NOW + 10 * 60 * 1000 });
    assert.equal(fake.db.tables.token_price_snapshots.length, 2);
  });

  it('reads either token order, and skips an empty or unreadable pool', async () => {
    const fake = createFakeSupabase({ token_price_snapshots: [] });
    const out = await runSnapshotTick({
      supabase: fake.client,
      provider: provider({
        // token1 is the token here, so reserve0 is the ETH side.
        [A.pair]: { token: WETH, reserveToken: 7n * E18, reserveEth: 3000n * E18 },
        [B.pair]: 'fail',
      }),
      chain: CHAIN,
      now: NOW,
      pools: [A, B],
    });
    assert.deepEqual(out, { written: 1, skipped: 1 });
    const [row] = fake.db.tables.token_price_snapshots;
    assert.equal(row.reserve_eth, String(7n * E18));
    assert.equal(row.reserve_token, String(3000n * E18));

    const empty = createFakeSupabase({ token_price_snapshots: [] });
    const none = await runSnapshotTick({
      supabase: empty.client,
      provider: provider({ [A.pair]: { token: A.token, reserveToken: 0n, reserveEth: E18 } }),
      chain: CHAIN,
      now: NOW,
      pools: [A],
    });
    assert.deepEqual(none, { written: 0, skipped: 1 });
    assert.equal(empty.db.tables.token_price_snapshots.length, 0);
  });

  it('snapshots FLZ and every listed token by default', async () => {
    const { verifiedPools } = require('../lib/priceReference');
    const { getDexConfig } = require('../lib/dex');
    const { LISTED_TOKENS } = require('../lib/listedTokens');
    const pools = verifiedPools(getDexConfig(CHAIN.id), LISTED_TOKENS);
    assert.equal(pools.length, 1 + LISTED_TOKENS.length);
    const seen = [];
    await runSnapshotTick({
      supabase: createFakeSupabase({ token_price_snapshots: [] }).client,
      provider: { call: async (tx) => (seen.push(String(tx.to).toLowerCase()), Promise.reject(new Error('stop'))) },
      chain: CHAIN,
      now: NOW,
    });
    for (const p of pools) assert.ok(seen.includes(p.pair), p.pair);
  });
});

describe('pruneSnapshots', () => {
  it('deletes rows older than two days and keeps the rest', async () => {
    const at = (ms) => new Date(NOW - ms).toISOString();
    const fake = createFakeSupabase({
      token_price_snapshots: [
        { id: 1, bucket: at(KEEP_MS + 60 * 1000) },
        { id: 2, bucket: at(KEEP_MS - 60 * 1000) },
        { id: 3, bucket: at(0) },
      ],
    });
    await pruneSnapshots(fake.client, NOW);
    assert.deepEqual(fake.db.tables.token_price_snapshots.map((r) => r.id), [2, 3]);
  });
});
