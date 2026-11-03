/**
 * The pair event index (web/lib/pairEvents.ts, web/lib/listedPairs.ts,
 * web/lib/noditSignature.ts, the Nodit webhook route and the migration).
 *
 * What is pinned: only the listed pairs from the token config are indexed;
 * only Swap and Sync logs from those pairs become rows; a log written twice
 * lands once (tx hash + log index); a chunk the node refuses twice is skipped
 * while the others land, and the cursor stops before the gap; the cursor never
 * moves back; a webhook only names transactions, each re-read on chain, and a
 * failed or foreign one writes nothing; the signature is checked before the
 * body is used; the window read prices by the pair's own token order.
 *
 * Run: node --test test/pairEvents.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

let E;
let L;
let N;
before(async () => {
  E = await import('../web/lib/pairEvents.ts');
  L = await import('../web/lib/listedPairs.ts');
  N = await import('../web/lib/noditSignature.ts');
});

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CHAIN = 91342;
const DEX = {
  flz: '0x308be8f71DA695f18E70D2243a446e1fD1566BA6',
  pair: '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227',
  wrappedNative: '0x3a13399f2741122B63c7710B2A85346B97C6BFDf',
};
const iface = new ethers.Interface([
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const who = '0x' + '11'.repeat(20);

function swapLog(pair, block, tx, index) {
  const enc = iface.encodeEventLog('Swap', [who, 1000n, 0n, 0n, 2000n, who]);
  return { address: pair, topics: enc.topics, data: enc.data, transactionHash: hash(tx), index, blockNumber: block };
}
function syncLog(pair, block, tx, index, r0, r1) {
  const enc = iface.encodeEventLog('Sync', [r0, r1]);
  return { address: pair, topics: enc.topics, data: enc.data, transactionHash: hash(tx), index, blockNumber: block };
}

/** A chain stand-in: logs by block, refusals by chunk start, receipts by hash. */
function chain({ head = 200_000, logs = [], refuse = new Set(), receipts = {} } = {}) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => head,
    getBlock: async (n) => ({ number: n, timestamp: 1_700_000_000 + n }),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (refuse.has(fromBlock)) throw new Error('range refused');
      const want = new Set([].concat(address).map((a) => a.toLowerCase()));
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && want.has(l.address.toLowerCase()));
    },
    getTransactionReceipt: async (h) => receipts[h] || null,
  };
}

let fake;
let pairs;
let flz;
beforeEach(() => {
  fake = createFakeSupabase({ pair_events: [], pair_index_cursors: [] });
  pairs = L.listedPairs(DEX);
  flz = pairs[0];
});
const rows = () => fake.db.tables.pair_events;

describe('listedPairs', () => {
  it('indexes FLZ and each listed token from the config, nothing else', () => {
    assert.deepEqual(
      pairs.map((p) => p.symbol),
      ['FLZ', 'DCAT', 'IZY', 'MAKI', 'TUSD']
    );
    assert.ok(pairs.every((p) => p.pair === p.pair.toLowerCase()));
    assert.doesNotMatch(read('web/lib/pairEvents.ts'), /allPairs|PairCreated/);
    assert.doesNotMatch(read('scripts/backfill-pair-events.mjs'), /allPairs|PairCreated/);
  });

  it('orders a pair by address the way Uniswap V2 does, and prices from that order', () => {
    // FLZ (0x308b...) sorts before WETH (0x3a13...), so FLZ is token0.
    assert.equal(flz.tokenIs0, true);
    // 1000 FLZ and 2 ETH: 0.002 ETH per FLZ.
    assert.equal(L.pairPriceEth(flz, 1000n * 10n ** 18n, 2n * 10n ** 18n), 0.002);
    assert.equal(L.pairPriceEth({ ...flz, tokenIs0: false }, 2n * 10n ** 18n, 1000n * 10n ** 18n), 0.002);
    assert.equal(L.pairPriceEth(flz, 0n, 1n), null);
  });
});

describe('decodePairLog', () => {
  it('keeps Swap and Sync from a listed pair, and nothing else', () => {
    const set = new Set([flz.pair]);
    const swap = E.decodePairLog(swapLog(DEX.pair, 5, 1, 0), set, CHAIN, 100);
    assert.equal(swap.kind, 'swap');
    assert.deepEqual([swap.amount0_in, swap.amount1_out, swap.reserve0], ['1000', '2000', null]);
    assert.equal(swap.block_time, new Date(100_000).toISOString());
    const sync = E.decodePairLog(syncLog(DEX.pair, 5, 1, 1, 7n, 9n), set, CHAIN, 100);
    assert.deepEqual([sync.kind, sync.reserve0, sync.reserve1], ['sync', '7', '9']);
    assert.equal(E.decodePairLog(swapLog('0x' + '99'.repeat(20), 5, 1, 0), set, CHAIN, 100), null, 'not a listed pair');
    const transfer = iface.encodeEventLog('Transfer', [who, who, 1n]);
    assert.equal(
      E.decodePairLog({ address: DEX.pair, topics: transfer.topics, data: transfer.data, transactionHash: hash(1), index: 2, blockNumber: 5 }, set, CHAIN, 100),
      null,
      'not a Swap or Sync'
    );
  });
});

describe('indexRange', () => {
  it('writes each log once, however many times it is read', async () => {
    const provider = chain({ logs: [swapLog(DEX.pair, 10, 1, 0), syncLog(DEX.pair, 10, 1, 1, 5n, 6n)] });
    await E.indexRange({ provider, db: fake.client, chainId: CHAIN, pairs: [flz], from: 0, to: 100 });
    await E.indexRange({ provider, db: fake.client, chainId: CHAIN, pairs: [flz], from: 0, to: 100 });
    assert.equal(rows().length, 2);
  });

  it('skips a chunk refused twice, keeps the rest, and stops the cursor before the gap', async () => {
    const provider = chain({
      logs: [swapLog(DEX.pair, 5, 1, 0), swapLog(DEX.pair, 25, 2, 0)],
      refuse: new Set([10]),
    });
    const r = await E.indexRange({ provider, db: fake.client, chainId: CHAIN, pairs: [flz], from: 0, to: 29, chunk: 10 });
    assert.deepEqual(r.failed, [[10, 19]]);
    assert.equal(r.contiguousTo, 9);
    assert.deepEqual(rows().map((x) => x.block_number).sort((a, b) => a - b), [5, 25], 'the chunk after the gap still landed');
    assert.equal(provider.calls.filter(([a]) => a === 10).length, 2, 'retried once');
  });
});

describe('pollPairs and the cursor', () => {
  it('starts a day back with no cursor, then resumes after it', async () => {
    const provider = chain({ head: 200_000 });
    await E.pollPairs({ provider, db: fake.client, chainId: CHAIN, pairs: [flz] });
    assert.equal(provider.calls[0][0], 200_000 - E.DAY_BLOCKS);
    assert.equal(fake.db.tables.pair_index_cursors[0].indexed_to, 200_000);
    const later = chain({ head: 200_050 });
    await E.pollPairs({ provider: later, db: fake.client, chainId: CHAIN, pairs: [flz] });
    assert.deepEqual(later.calls, [[200_001, 200_050]]);
  });

  it('never moves a cursor back', async () => {
    await E.advanceCursor(fake.client, CHAIN, flz.pair, 500);
    await E.advanceCursor(fake.client, CHAIN, flz.pair, 300);
    assert.equal(fake.db.tables.pair_index_cursors.length, 1);
    assert.equal(fake.db.tables.pair_index_cursors[0].indexed_to, 500);
  });
});

describe('the webhook path', () => {
  it('finds transaction hashes in a body, not block hashes, and caps them', () => {
    const body = {
      event: { messages: [{ transaction_hash: hash(1), block_hash: hash(2), topics: [hash(3)] }, { transactionHash: hash(4) }] },
    };
    assert.deepEqual(E.txHashesIn(body), [hash(1), hash(4)]);
    const many = { messages: Array.from({ length: 80 }, (_, i) => ({ transaction_hash: hash(i + 10) })) };
    assert.equal(E.txHashesIn(many).length, E.MAX_WEBHOOK_TXS);
  });

  it('re-reads each named transaction on chain and keeps only a successful one from a listed pair', async () => {
    const ok = hash(1);
    const reverted = hash(2);
    const foreign = hash(3);
    const receipts = {
      [ok]: { hash: ok, status: 1, blockNumber: 50, logs: [swapLog(DEX.pair, 50, 1, 4), syncLog(DEX.pair, 50, 1, 5, 1n, 2n)] },
      [reverted]: { hash: reverted, status: 0, blockNumber: 51, logs: [swapLog(DEX.pair, 51, 2, 0)] },
      [foreign]: { hash: foreign, status: 1, blockNumber: 52, logs: [swapLog('0x' + '99'.repeat(20), 52, 3, 0)] },
    };
    const provider = chain({ receipts });
    const n = await E.indexTransactions({ provider, db: fake.client, chainId: CHAIN, pairs, txHashes: [ok, reverted, foreign, hash(9)] });
    assert.equal(n, 2);
    assert.deepEqual(rows().map((r) => [r.tx_hash, r.log_index]), [[ok, 4], [ok, 5]]);
    await E.indexTransactions({ provider, db: fake.client, chainId: CHAIN, pairs, txHashes: [ok] });
    assert.equal(rows().length, 2, 'a resend lands once');
  });

  it('checks the Nodit signature, raw or as Nodit re-serializes it, with the server-only key', () => {
    const key = 'k-test';
    const raw = '{ "event": { "messages": [] } }';
    const sign = (t) => crypto.createHmac('sha256', key).update(t).digest('hex');
    assert.equal(N.noditSignatureOk(raw, sign(raw), key), true);
    assert.equal(N.noditSignatureOk(raw, sign(JSON.stringify(JSON.parse(raw))), key), true);
    assert.equal(N.noditSignatureOk(raw, sign(raw), 'other'), false);
    assert.equal(N.noditSignatureOk(raw, null, key), false);
    assert.equal(N.noditSignatureOk(raw, sign(raw), undefined), false);
  });

  it('verifies the signature before it parses or uses the body, and keeps the key server only', () => {
    const route = read('web/app/api/webhooks/nodit/route.ts');
    const check = route.indexOf('noditSignatureOk(raw');
    assert.ok(check > 0 && route.indexOf('JSON.parse(raw)') > check);
    assert.ok(route.indexOf('indexTransactions(') > check);
    assert.match(route, /process\.env\.NODIT_WEBHOOK_SIGNING_KEY/);
    assert.doesNotMatch(read('web/lib/noditSignature.ts') + route, /NEXT_PUBLIC_/);
    assert.match(read('.env.example'), /# NODIT_WEBHOOK_SIGNING_KEY=/);
  });
});

describe('readPairWindow', () => {
  it('prices each Sync in the window and the last one before it, and counts the swaps', async () => {
    const now = 1_800_000_000;
    const iso = (t) => new Date(t * 1000).toISOString();
    const base = { chain_id: CHAIN, pair: flz.pair, amount0_in: null, amount1_in: null, amount0_out: null, amount1_out: null };
    fake.db.tables.pair_events = [
      { ...base, tx_hash: hash(1), log_index: 1, block_number: 1, block_time: iso(now - 2 * 86400), kind: 'sync', reserve0: String(1000n * 10n ** 18n), reserve1: String(1n * 10n ** 18n) },
      { ...base, tx_hash: hash(2), log_index: 1, block_number: 2, block_time: iso(now - 600), kind: 'sync', reserve0: String(1000n * 10n ** 18n), reserve1: String(2n * 10n ** 18n) },
      { ...base, tx_hash: hash(2), log_index: 0, block_number: 2, block_time: iso(now - 600), kind: 'swap', reserve0: null, reserve1: null },
      { ...base, pair: pairs[1].pair, tx_hash: hash(3), log_index: 0, block_number: 3, block_time: iso(now - 60), kind: 'swap', reserve0: null, reserve1: null },
    ];
    const w = await E.readPairWindow(fake.client, CHAIN, flz, now);
    assert.equal(w.trades, 1);
    assert.deepEqual(w.prices.map((p) => p.priceEth).sort(), [0.001, 0.002]);
  });
});

describe('the migration and the indexer agree', () => {
  const sql = read('supabase/migrations/20261103120000_pair_events.sql');
  it('keys a row by chain, tx hash and log index, and keeps both tables service role only', () => {
    assert.match(sql, /primary key \(chain_id, tx_hash, log_index\)/);
    assert.match(read('web/lib/pairEvents.ts'), /onConflict: 'chain_id,tx_hash,log_index',\s*ignoreDuplicates: true/);
    assert.match(sql, /alter table public\.pair_events enable row level security;/);
    assert.match(sql, /revoke all on table public\.pair_events from anon, authenticated;/);
    assert.match(sql, /revoke all on table public\.pair_index_cursors from anon, authenticated;/);
    assert.match(sql, /do \$\$[\s\S]*raise exception/);
  });

  it('never lets one refused chunk blank the detail chart either', () => {
    const src = read('web/lib/tokenMarketServer.ts');
    assert.match(src, /if \(chunks\.length && parts\.every\(\(p\) => p === null\)\) throw new Error\('every log chunk failed'\);/);
    assert.match(src, /return \{ logs: parts\.flatMap\(\(p\) => p \?\? \[\]\), missed: parts\.filter\(\(p\) => p === null\)\.length \};/);
    assert.match(src, /day\.partial = missed > 0;/);
    assert.match(src, /trades: unknown \? null : windowPrints\.length,/);
  });
});

describe('the Explore row', () => {
  const ui = read('web/components/ExploreTokens.tsx');
  it('never draws the dashed empty line, and shows the 24-hour trade count', () => {
    assert.doesNotMatch(ui, /strokeDasharray/);
    assert.match(ui, /'No trades in 24h'/);
    assert.match(ui, /tradesLabel\(row\.trades as number\)/);
  });

  it('keeps room for the price on a narrow screen', () => {
    assert.match(ui, /minmax\(66px,1fr\)\]/);
  });
});
