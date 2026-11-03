/**
 * The Swap and Sync index of the listed pairs (supabase/migrations/
 * 20261103120000_pair_events.sql).
 *
 * Three writers share this file and none of them is trusted on its own word:
 *   - the poller reads logs with eth_getLogs from where the pair's cursor
 *     stopped (never further back than 24 hours) toward the chain head, a
 *     bounded slice per call;
 *   - the backfill script reads them from a pair's deploy block;
 *   - the Nodit webhook only names transactions. Each is re-read here with
 *     eth_getTransactionReceipt, and only a successful transaction's logs that
 *     a listed pair emitted, with the Swap or Sync topic, are kept.
 * Every row is keyed by chain, tx hash and log index and inserted with
 * ignoreDuplicates, so a log written twice lands once.
 *
 * A log range the node refuses twice is split and read in smaller pieces; one
 * that still cannot be read is skipped: the other chunks are still written,
 * and the cursor stops before the gap so the next run reads it again.
 *
 * The database and the provider arrive as arguments; nothing here reaches for
 * a global client, so a script and the tests can drive it.
 */

import { ethers } from 'ethers';
import type { ListedPair } from './listedPairs.ts';
import { pairPriceEth } from './listedPairs.ts';
import type { PricePoint } from './priceSeries.ts';

const PAIR_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
];
const iface = new ethers.Interface(PAIR_ABI);
export const SWAP_TOPIC = iface.getEvent('Swap')!.topicHash;
export const SYNC_TOPIC = iface.getEvent('Sync')!.topicHash;

/** Under GIWA's refusal point (about 10,000 blocks per log request). */
export const LOG_CHUNK = 9_000;
/** The smallest range a refused log request is split down to before it counts as failed. */
export const MIN_SPLIT = 1_000;
/**
 * Blocks one poll reads at most (three chunks, 7.5 hours). A request that
 * refreshes the index stays short; a pair that is further behind catches up
 * over the next polls, and until then its row reads the chain directly.
 */
export const MAX_POLL_BLOCKS = 3 * LOG_CHUNK;
/** A pair's index is used for its row only when its cursor is this close to the head (two minutes). */
export const FRESH_BLOCKS = 120;
/** GIWA closes a block every second, so a day is this many blocks. */
export const DAY_BLOCKS = 86_400;
/** Transactions one webhook call may ask about. */
export const MAX_WEBHOOK_TXS = 50;

export type PairEventRow = {
  chain_id: number;
  pair: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: string;
  kind: 'swap' | 'sync';
  amount0_in: string | null;
  amount1_in: string | null;
  amount0_out: string | null;
  amount1_out: string | null;
  reserve0: string | null;
  reserve1: string | null;
};

/** Shallow on purpose: a full Supabase client type is too deep for tsc here. */
export type EventDb = { from: (table: string) => unknown };
type DbError = { code?: string; message?: string } | null;
type Result<T> = PromiseLike<{ data: T | null; error: DbError }>;

/** The query builder calls this file makes, and nothing more. */
type Query = PromiseLike<{ data: unknown; error: DbError; count?: number | null }> & {
  select(cols: string, opts?: { count?: 'exact'; head?: boolean }): Query;
  eq(col: string, value: unknown): Query;
  gte(col: string, value: unknown): Query;
  lt(col: string, value: unknown): Query;
  order(col: string, opts: { ascending: boolean }): Query;
  limit(n: number): Query;
  update(values: Record<string, unknown>): Query;
  upsert(values: unknown, opts: { onConflict: string; ignoreDuplicates: boolean }): Query;
};

// The two places the shallow client is narrowed to the calls above. The table
// names stay literal so the schema guard can see them.
function events(db: EventDb): Query {
  return db.from('pair_events') as Query;
}
function cursors(db: EventDb): Query {
  return db.from('pair_index_cursors') as Query;
}

export type ChainReader = Pick<ethers.JsonRpcProvider, 'getLogs' | 'getBlock' | 'getBlockNumber' | 'getTransactionReceipt'>;

type RawLog = { address: string; topics: readonly string[]; data: string; transactionHash: string; index: number; blockNumber: number };

/** A Swap or Sync log of one of the pairs as a row, or null for anything else. */
export function decodePairLog(log: RawLog, pairs: Set<string>, chainId: number, blockTime: number): PairEventRow | null {
  const pair = String(log.address || '').toLowerCase();
  if (!pairs.has(pair)) return null;
  const topic = log.topics?.[0];
  if (topic !== SWAP_TOPIC && topic !== SYNC_TOPIC) return null;
  let parsed: ethers.LogDescription | null = null;
  try {
    parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const base = {
    chain_id: chainId,
    pair,
    tx_hash: String(log.transactionHash).toLowerCase(),
    log_index: Number(log.index),
    block_number: Number(log.blockNumber),
    block_time: new Date(blockTime * 1000).toISOString(),
    amount0_in: null,
    amount1_in: null,
    amount0_out: null,
    amount1_out: null,
    reserve0: null,
    reserve1: null,
  };
  if (!/^0x[0-9a-f]{64}$/.test(base.tx_hash) || !Number.isInteger(base.log_index) || base.log_index < 0) return null;
  if (parsed.name === 'Swap') {
    return {
      ...base,
      kind: 'swap',
      amount0_in: String(parsed.args.amount0In),
      amount1_in: String(parsed.args.amount1In),
      amount0_out: String(parsed.args.amount0Out),
      amount1_out: String(parsed.args.amount1Out),
    };
  }
  return { ...base, kind: 'sync', reserve0: String(parsed.args.reserve0), reserve1: String(parsed.args.reserve1) };
}

/** The table, or the cursor table, does not exist yet (migration not applied). */
export function eventStoreMissing(error: DbError): boolean {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  if (code === 'PGRST205' || code === '42P01') return true;
  return /pair_events|pair_index_cursors/i.test(msg) && /schema cache|does not exist|could not find/i.test(msg);
}

async function insertRows(db: EventDb, rows: PairEventRow[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await (events(db).upsert(rows, {
    onConflict: 'chain_id,tx_hash,log_index',
    ignoreDuplicates: true,
  }) as Result<unknown>);
  if (error) throw new Error(error.message || 'pair_events write failed');
}

/** Block timestamps, read once per block. */
async function blockTimes(provider: ChainReader, numbers: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const n of [...new Set(numbers)]) {
    const block = await provider.getBlock(n);
    if (!block) throw new Error(`block ${n} not found`);
    out.set(n, block.timestamp);
  }
  return out;
}

export type RangeResult = {
  rows: number;
  /** Chunks the node refused twice. */
  failed: Array<[number, number]>;
  /** The last block below which every chunk was read, or from - 1 when the first one failed. */
  contiguousTo: number;
};

/**
 * One pair's Swap and Sync logs over [a, b]: one address per request, the
 * shape the chart's own read already uses on every RPC. Tried twice; a range
 * still refused is split in half and each half read the same way, down to
 * MIN_SPLIT blocks, in case the node caps the range below LOG_CHUNK. Null when
 * some part could not be read.
 */
async function pairLogs(provider: ChainReader, address: string, a: number, b: number): Promise<RawLog[] | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return (await provider.getLogs({ address, topics: [[SWAP_TOPIC, SYNC_TOPIC]], fromBlock: a, toBlock: b })) as unknown as RawLog[];
    } catch {
      // Retried once, then split below.
    }
  }
  if (b - a + 1 <= MIN_SPLIT) return null;
  const mid = a + Math.floor((b - a) / 2);
  const left = await pairLogs(provider, address, a, mid);
  if (left === null) return null;
  const right = await pairLogs(provider, address, mid + 1, b);
  return right === null ? null : [...left, ...right];
}

/**
 * Swap and Sync logs of the pairs over [from, to], written to pair_events.
 * Chunks run in order, each pair read in parallel within a chunk; a chunk
 * that cannot be read for some pair is skipped and reported, and the rest
 * still land.
 */
export async function indexRange(args: {
  provider: ChainReader;
  db: EventDb;
  chainId: number;
  pairs: ListedPair[];
  from: number;
  to: number;
  chunk?: number;
}): Promise<RangeResult> {
  const { provider, db, chainId, pairs, from, to } = args;
  const size = args.chunk ?? LOG_CHUNK;
  const set = new Set(pairs.map((p) => p.pair));
  const addresses = pairs.map((p) => ethers.getAddress(p.pair));
  const failed: Array<[number, number]> = [];
  let contiguousTo = from - 1;
  let gap = false;
  let rows = 0;
  for (let a = from; a <= to; a += size) {
    const b = Math.min(to, a + size - 1);
    const parts = await Promise.all(addresses.map((address) => pairLogs(provider, address, a, b)));
    const logs = parts.some((p) => p === null) ? null : parts.flatMap((p) => p as RawLog[]);
    if (logs === null) {
      failed.push([a, b]);
      gap = true;
      continue;
    }
    const times = await blockTimes(provider, logs.map((l) => l.blockNumber));
    const decoded = logs
      .map((l) => decodePairLog(l, set, chainId, times.get(l.blockNumber) ?? 0))
      .filter((r): r is PairEventRow => r !== null);
    await insertRows(db, decoded);
    rows += decoded.length;
    if (!gap) contiguousTo = b;
  }
  return { rows, failed, contiguousTo };
}

/** Where each pair's index stands. A pair with no row has not been read. */
async function readCursors(db: EventDb, chainId: number): Promise<Map<string, number>> {
  const { data, error } = await (cursors(db).select('pair, indexed_to').eq('chain_id', chainId) as Result<
    Array<{ pair: string; indexed_to: number | string }>
  >);
  if (error) throw Object.assign(new Error(error.message || 'cursor read failed'), { code: error.code });
  return new Map((data || []).map((r) => [String(r.pair).toLowerCase(), Number(r.indexed_to)]));
}

/** Moves a cursor forward only: a slower writer never moves it back. */
export async function advanceCursor(db: EventDb, chainId: number, pair: string, to: number): Promise<void> {
  const now = new Date().toISOString();
  const { error: insErr } = await (cursors(db).upsert(
    { chain_id: chainId, pair, indexed_to: to, updated_at: now },
    { onConflict: 'chain_id,pair', ignoreDuplicates: true }
  ) as Result<unknown>);
  if (insErr) throw new Error(insErr.message || 'cursor write failed');
  const { error } = await (cursors(db)
    .update({ indexed_to: to, updated_at: now })
    .eq('chain_id', chainId)
    .eq('pair', pair)
    .lt('indexed_to', to) as Result<unknown>);
  if (error) throw new Error(error.message || 'cursor write failed');
}

/**
 * Moves every pair toward the head, at most MAX_POLL_BLOCKS per call. A pair
 * starts where its cursor stopped, or a day back when it has none or fell more
 * than a day behind (the backfill fills older history). Pairs at the same
 * block are read together. Returns the head and where each pair's cursor now
 * stands, so the caller can tell which pairs are current.
 */
export async function pollPairs(args: { provider: ChainReader; db: EventDb; chainId: number; pairs: ListedPair[] }): Promise<{
  rows: number;
  failed: number;
  head: number;
  indexedTo: Map<string, number>;
}> {
  const { provider, db, chainId, pairs } = args;
  const head = await provider.getBlockNumber();
  const indexedTo = await readCursors(db, chainId);
  const floor = Math.max(0, head - DAY_BLOCKS);
  const groups = new Map<number, ListedPair[]>();
  for (const p of pairs) {
    const at = indexedTo.get(p.pair);
    const from = at == null ? floor : Math.max(at + 1, floor);
    if (from > head) continue;
    groups.set(from, [...(groups.get(from) || []), p]);
  }
  let rows = 0;
  let failed = 0;
  for (const [from, group] of groups) {
    const to = Math.min(head, from + MAX_POLL_BLOCKS - 1);
    const result = await indexRange({ provider, db, chainId, pairs: group, from, to });
    rows += result.rows;
    failed += result.failed.length;
    if (result.contiguousTo >= from) {
      for (const p of group) {
        await advanceCursor(db, chainId, p.pair, result.contiguousTo);
        indexedTo.set(p.pair, Math.max(indexedTo.get(p.pair) ?? -1, result.contiguousTo));
      }
    }
  }
  return { rows, failed, head, indexedTo };
}

/** Whether a pair's index reaches close enough to the head to be shown as it is. */
export function isCurrent(indexedTo: number | undefined, head: number): boolean {
  return indexedTo != null && indexedTo >= head - FRESH_BLOCKS;
}

/** Transaction hashes anywhere in a webhook body, lower case, at most MAX_WEBHOOK_TXS. */
export function txHashesIn(body: unknown): string[] {
  const found = new Set<string>();
  // Only values under a key that names a transaction count: a block hash or a
  // log topic is the same shape and is not one.
  const visit = (value: unknown, depth: number, txKey: boolean) => {
    if (found.size >= MAX_WEBHOOK_TXS || depth > 8 || value == null) return;
    if (typeof value === 'string') {
      if (txKey && /^0x[0-9a-fA-F]{64}$/.test(value)) found.add(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, txKey);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        visit(item, depth + 1, /^(transaction_?hash|tx_?hash)$/i.test(key));
      }
    }
  };
  visit(body, 0, false);
  return [...found];
}

/**
 * The webhook path: each named transaction is read from the chain, and only a
 * successful one's Swap and Sync logs from the listed pairs are written.
 * Returns how many rows were offered; duplicates are ignored by the table.
 */
export async function indexTransactions(args: {
  provider: ChainReader;
  db: EventDb;
  chainId: number;
  pairs: ListedPair[];
  txHashes: string[];
}): Promise<number> {
  const { provider, db, chainId, pairs } = args;
  const set = new Set(pairs.map((p) => p.pair));
  let rows = 0;
  for (const hash of args.txHashes.slice(0, MAX_WEBHOOK_TXS)) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1) continue;
    const logs = receipt.logs as unknown as RawLog[];
    if (!logs.some((l) => set.has(String(l.address).toLowerCase()))) continue;
    const times = await blockTimes(provider, [receipt.blockNumber]);
    const decoded = logs
      .map((l) => decodePairLog({ ...l, blockNumber: receipt.blockNumber, transactionHash: receipt.hash }, set, chainId, times.get(receipt.blockNumber) ?? 0))
      .filter((r): r is PairEventRow => r !== null);
    await insertRows(db, decoded);
    rows += decoded.length;
  }
  return rows;
}

export type PairWindow = { prices: PricePoint[]; trades: number };

/**
 * What a pair's 24-hour row needs from the index: the pool price after every
 * Sync in the window, the last one before it (the opening price), and how many
 * swaps the window holds.
 */
export async function readPairWindow(db: EventDb, chainId: number, p: ListedPair, now: number): Promise<PairWindow> {
  const since = new Date((now - DAY_BLOCKS) * 1000).toISOString();
  const syncCols = 'block_time, block_number, log_index, reserve0, reserve1';
  const [inside, before, swaps] = await Promise.all([
    events(db).select(syncCols).eq('chain_id', chainId).eq('pair', p.pair).eq('kind', 'sync').gte('block_time', since).limit(5000) as Result<SyncRow[]>,
    events(db)
      .select(syncCols)
      .eq('chain_id', chainId)
      .eq('pair', p.pair)
      .eq('kind', 'sync')
      .lt('block_time', since)
      .order('block_number', { ascending: false })
      .order('log_index', { ascending: false })
      .limit(1) as Result<SyncRow[]>,
    events(db)
      .select('tx_hash', { count: 'exact', head: true })
      .eq('chain_id', chainId)
      .eq('pair', p.pair)
      .eq('kind', 'swap')
      .gte('block_time', since) as PromiseLike<{ count: number | null; error: DbError }>,
  ]);
  for (const r of [inside, before, swaps]) {
    if (r.error) throw Object.assign(new Error(r.error.message || 'pair_events read failed'), { code: r.error.code });
  }
  const toPoint = (row: SyncRow): PricePoint | null => {
    const priceEth = pairPriceEth(p, BigInt(row.reserve0), BigInt(row.reserve1));
    const time = Math.floor(Date.parse(row.block_time) / 1000);
    return priceEth == null || !Number.isFinite(time) ? null : { time, priceEth };
  };
  const prices = [...(before.data || []), ...(inside.data || [])].map(toPoint).filter((x): x is PricePoint => x !== null);
  return { prices, trades: swaps.count ?? 0 };
}

type SyncRow = { block_time: string; block_number: number; log_index: number; reserve0: string; reserve1: string };
