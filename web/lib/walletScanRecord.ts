import { ethers } from 'ethers';
import type { getSupabase } from './supabase';
import { MARKET_ABI } from './nftMarket.ts';
import { displaySafeLabel } from './sanitize.ts';

/**
 * Transactions a wallet outside Flizy signed on Flizy, recorded for Scan as
 * a guest's.
 *
 * A trade from a Flizy wallet is logged by the route that sends it. Any other
 * wallet reaches Scan two ways: the page hands the hash over once it lands
 * (POST /api/scan/record), and Scan itself reads the latest calls to the fee
 * router and the marketplace from the explorer (syncWalletScan), which also
 * catches trades by people with no Flizy account. Either way the server reads
 * what happened from the chain: the transaction, its receipt and the logs of
 * Flizy's own contracts. Nothing the page or the explorer says about amounts
 * or tokens is used.
 *
 * Three kinds are recorded: a swap through Flizy's fee router, a marketplace
 * action, and a deposit into a Flizy account's wallet (ETH, FLZ or a listed
 * token). Anything else is not Flizy activity and is left out.
 *
 * Rows go into transfers with no account and channel key 'wallet', like the
 * outside-wallet payments in web/lib/externalPay.ts. Spending limits and an
 * account's own history read rows by account, so these touch neither; a
 * deposit shows in the receiving account's history, as any payment to its
 * wallet does. A unique index on the hash for this channel
 * (supabase/migrations/20261023120000_wallet_scan_rows.sql) records each
 * transaction once, however many times it is handed over.
 */

type Db = ReturnType<typeof getSupabase>;

/** How old a handed-over transaction may be and still be recorded. The page hands the hash over as soon as it lands. */
export const RECORD_WINDOW_S = 60 * 60;

/** The channel key on these rows. Scan shows it as "Guest" (web/lib/historyRow.ts). */
export const WALLET_CHANNEL = 'wallet';

export type ScanToken = { address: string; symbol: string; decimals: number };

/** Flizy's contracts and tokens, as this deployment has them. */
export type ScanSetup = {
  feeRouter: string;
  weth: string;
  market: string | null;
  /** Tokens a swap or deposit may move. ETH is implied. */
  tokens: readonly ScanToken[];
};

type Log = { address: string; topics: ReadonlyArray<string>; data: string };

/** The parts of a mined transaction this file reads. */
export type ChainTx = { from: string; to: string | null; value: bigint; data: string; logs: readonly Log[] };

export type MarketMove =
  | { name: 'Sold'; collection: string; tokenId: string; buyer: string; seller: string; price: bigint }
  | { name: 'OfferMade'; collection: string; tokenId: string | null; amount: bigint }
  | { name: 'Listed'; collection: string; tokenId: string; price: bigint }
  | { name: 'ListingCancelled'; collection: string; tokenId: string }
  | { name: 'OfferCancelled' }
  | { name: 'Withdrawn'; amount: bigint }
  | { name: 'RoyaltySet'; collection: string; bps: bigint };

/** What a transaction did, read from the chain. null token = ETH. */
export type WalletMove =
  | { kind: 'swap'; wallet: string; tokenIn: ScanToken | null; amountIn: bigint; tokenOut: ScanToken | null; amountOut: bigint }
  | { kind: 'market'; wallet: string; value: bigint; event: MarketMove }
  | { kind: 'deposit'; wallet: string; to: string; token: ScanToken | null; units: bigint };

const ROUTER_IFACE = new ethers.Interface([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);

const TOKEN_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Withdrawal(address indexed src, uint256 wad)',
  'function transfer(address to, uint256 amount)',
]);

// Withdrawn is not in MARKET_ABI: nothing else on the site reads it.
const MARKET_IFACE = new ethers.Interface([...MARKET_ABI, 'event Withdrawn(address indexed to, uint256 amount)']);

/** When one transaction emits several marketplace events, the first name here is the one it is recorded as. */
const MARKET_ORDER: ReadonlyArray<MarketMove['name']> = [
  'Sold',
  'OfferMade',
  'Listed',
  'ListingCancelled',
  'OfferCancelled',
  'Withdrawn',
  'RoyaltySet',
];

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

function parseLog(iface: ethers.Interface, log: Log): ethers.LogDescription | null {
  try {
    return iface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null;
  }
}

function parseCall(iface: ethers.Interface, tx: ChainTx): ethers.TransactionDescription | null {
  try {
    return iface.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return null;
  }
}

/** ETH (null), a known token, or undefined for a token this deployment does not list. */
function tokenAt(setup: ScanSetup, address: string): ScanToken | null | undefined {
  if (same(address, setup.weth)) return null;
  return setup.tokens.find((t) => same(t.address, address));
}

function readSwap(tx: ChainTx, setup: ScanSetup): WalletMove | null {
  const call = parseCall(ROUTER_IFACE, tx);
  if (!call) return null;
  const path = (call.args.path as string[]).map((a) => ethers.getAddress(a));
  const recipient = ethers.getAddress(String(call.args.to));
  if (path.length < 2) return null;
  const tokenIn = tokenAt(setup, path[0]);
  const tokenOut = tokenAt(setup, path[path.length - 1]);
  if (tokenIn === undefined || tokenOut === undefined) return null;
  const amountIn = call.name === 'swapExactETHForTokens' ? tx.value : BigInt(call.args.amountIn);

  // ETH out arrives as WETH unwrapped by the pool router; a token out is a
  // Transfer to the recipient. Only logs of that token's own contract count.
  let amountOut = 0n;
  for (const log of tx.logs) {
    if (tokenOut === null) {
      if (!same(log.address, setup.weth)) continue;
      const parsed = parseLog(TOKEN_IFACE, log);
      if (parsed?.name === 'Withdrawal') amountOut += BigInt(parsed.args.wad);
    } else {
      if (!same(log.address, tokenOut.address)) continue;
      const parsed = parseLog(TOKEN_IFACE, log);
      if (parsed?.name === 'Transfer' && same(String(parsed.args.to), recipient)) amountOut += BigInt(parsed.args.value);
    }
  }
  if (amountIn <= 0n || amountOut <= 0n) return null;
  return { kind: 'swap', wallet: ethers.getAddress(tx.from), tokenIn, amountIn, tokenOut, amountOut };
}

function marketMove(parsed: ethers.LogDescription): MarketMove | null {
  const a = parsed.args;
  const addr = (v: unknown) => ethers.getAddress(String(v));
  switch (parsed.name) {
    case 'Sold':
      return { name: 'Sold', collection: addr(a.collection), tokenId: BigInt(a.tokenId).toString(), buyer: addr(a.buyer), seller: addr(a.seller), price: BigInt(a.price) };
    case 'OfferMade':
      return { name: 'OfferMade', collection: addr(a.collection), tokenId: a.anyToken ? null : BigInt(a.tokenId).toString(), amount: BigInt(a.amount) };
    case 'Listed':
      return { name: 'Listed', collection: addr(a.collection), tokenId: BigInt(a.tokenId).toString(), price: BigInt(a.price) };
    case 'ListingCancelled':
      return { name: 'ListingCancelled', collection: addr(a.collection), tokenId: BigInt(a.tokenId).toString() };
    case 'OfferCancelled':
      return { name: 'OfferCancelled' };
    case 'Withdrawn':
      return { name: 'Withdrawn', amount: BigInt(a.amount) };
    case 'RoyaltySet':
      return { name: 'RoyaltySet', collection: addr(a.collection), bps: BigInt(a.bps) };
    default:
      return null;
  }
}

function readMarket(tx: ChainTx, market: string): WalletMove | null {
  const moves: MarketMove[] = [];
  for (const log of tx.logs) {
    if (!same(log.address, market)) continue;
    const parsed = parseLog(MARKET_IFACE, log);
    const move = parsed ? marketMove(parsed) : null;
    if (move) moves.push(move);
  }
  for (const name of MARKET_ORDER) {
    const event = moves.find((m) => m.name === name);
    if (event) return { kind: 'market', wallet: ethers.getAddress(tx.from), value: tx.value, event };
  }
  return null;
}

/** A plain ETH send, or a transfer() on a known token with its Transfer log. The receiver is checked by the caller. */
function readDeposit(tx: ChainTx, setup: ScanSetup): WalletMove | null {
  const to = tx.to as string;
  const wallet = ethers.getAddress(tx.from);
  if (tx.data === '0x' || tx.data === '') {
    return tx.value > 0n ? { kind: 'deposit', wallet, to: ethers.getAddress(to), token: null, units: tx.value } : null;
  }
  const token = setup.tokens.find((t) => same(t.address, to));
  if (!token) return null;
  const call = parseCall(TOKEN_IFACE, tx);
  if (call?.name !== 'transfer') return null;
  const receiver = ethers.getAddress(String(call.args.to));
  const units = BigInt(call.args.amount);
  const logged = tx.logs.some((log) => {
    if (!same(log.address, token.address)) return false;
    const parsed = parseLog(TOKEN_IFACE, log);
    return parsed?.name === 'Transfer' && same(String(parsed.args.from), wallet) && same(String(parsed.args.to), receiver) && BigInt(parsed.args.value) === units;
  });
  return logged && units > 0n ? { kind: 'deposit', wallet, to: receiver, token, units } : null;
}

/** What a successful transaction did on Flizy, or null when it was not Flizy activity. */
export function readWalletMove(tx: ChainTx, setup: ScanSetup): WalletMove | null {
  if (!tx.to) return null;
  if (same(tx.to, setup.feeRouter)) return readSwap(tx, setup);
  if (setup.market && same(tx.to, setup.market)) return readMarket(tx, setup.market);
  return readDeposit(tx, setup);
}

/** The collection a marketplace move names, for its display name. */
export function moveCollection(move: WalletMove): string | null {
  return move.kind === 'market' && 'collection' in move.event ? move.event.collection : null;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function eth(wei: bigint): string {
  return ethers.formatEther(wei);
}

/** The label a marketplace row carries, worded as the site's own trades are. */
export function marketLabel(move: Extract<WalletMove, { kind: 'market' }>, collectionName: string | null): string {
  const e = move.event;
  const name = 'collection' in e ? displaySafeLabel(collectionName, 40) || shortAddress(e.collection) : '';
  const item = (tokenId: string | null) => (tokenId ? `${name} #${tokenId}` : `any ${name}`);
  switch (e.name) {
    case 'Sold':
      return same(e.buyer, move.wallet) ? `Buy ${item(e.tokenId)} for ${eth(e.price)} ETH` : `Sell ${item(e.tokenId)} for ${eth(e.price)} ETH`;
    case 'OfferMade':
      return `Offer ${eth(e.amount)} ETH for ${item(e.tokenId)}`;
    case 'Listed':
      return `List ${item(e.tokenId)} for ${eth(e.price)} ETH`;
    case 'ListingCancelled':
      return `Cancel listing of ${item(e.tokenId)}`;
    case 'OfferCancelled':
      return 'Cancel an offer';
    case 'Withdrawn':
      return `Withdraw ${eth(e.amount)} ETH from sales`;
    case 'RoyaltySet':
      return `Set ${name} royalty to ${Number(e.bps) / 100}%`;
  }
}

function units(amount: bigint, token: ScanToken | null): string {
  return ethers.formatUnits(amount, token ? token.decimals : 18);
}

/** The transfers row for a move. `at` is the block's time, so the row sorts where it happened. */
export function walletScanRow(
  move: WalletMove,
  p: { txHash: string; chainId: number; at: Date; collectionName?: string | null }
): Record<string, unknown> {
  const base = {
    account_id: null,
    phone: WALLET_CHANNEL,
    status: 'confirmed',
    tx_hash: p.txHash.toLowerCase(),
    chain_id: p.chainId,
    direction: 'out',
    created_at: p.at.toISOString(),
  };
  if (move.kind === 'swap') {
    const inLabel = move.tokenIn ? move.tokenIn.symbol : 'ETH';
    const outLabel = move.tokenOut ? move.tokenOut.symbol : 'ETH';
    // Swap and marketplace rows log the wallet as the address, so a Scan search for the wallet finds them.
    return {
      ...base,
      to_address: move.wallet,
      amount_eth: units(move.amountIn, move.tokenIn),
      kind: 'swap',
      asset: inLabel,
      amount_secondary: units(move.amountOut, move.tokenOut),
      asset_secondary: outLabel,
      counterparty_label: `swap → ${outLabel}`,
    };
  }
  if (move.kind === 'market') {
    return {
      ...base,
      to_address: move.wallet,
      amount_eth: eth(move.value),
      kind: 'nft_market',
      asset: 'ETH',
      counterparty_label: marketLabel(move, p.collectionName ?? null),
    };
  }
  // A deposit is logged to the Flizy wallet it reached and names the sender
  // the way a payment from outside does (web/lib/externalPay.ts).
  return {
    ...base,
    to_address: move.to,
    amount_eth: units(move.units, move.token),
    kind: 'transfer',
    asset: move.token ? move.token.symbol : 'ETH',
    token_address: move.token ? ethers.getAddress(move.token.address) : null,
    counterparty_label: `${move.wallet.slice(0, 6)}…${move.wallet.slice(-4)}`,
  };
}

/**
 * Whether Flizy already logged this transaction as its own: a send from a
 * Flizy wallet, a faucet drip, or a claim payout or refund. The faucet and the
 * claim escrow send plain ETH and token transfers to Flizy wallets, which read
 * like deposits from outside, and History already shows each of them.
 */
async function loggedByFlizy(supabase: Db, txHash: string): Promise<boolean> {
  const hash = txHash.toLowerCase();
  const checks = await Promise.all([
    supabase.from('transfers').select('id').eq('tx_hash', hash).limit(1),
    supabase.from('faucet_claims').select('id').eq('tx_hash', hash).limit(1),
    supabase.from('claims').select('id').eq('claim_tx_hash', hash).limit(1),
    supabase.from('claims').select('id').eq('refund_tx_hash', hash).limit(1),
  ]);
  for (const check of checks) {
    if (check.error) throw new Error(check.error.message);
    if ((check.data || []).length > 0) return true;
  }
  return false;
}

/** Whether an address is a Flizy account's wallet. Both spellings are asked for: wallets are stored checksummed. */
async function isFlizyWallet(supabase: Db, address: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id')
    .in('agent_wallet_address', [address.toLowerCase(), ethers.getAddress(address)])
    .limit(1);
  if (error) throw new Error(error.message);
  return (data || []).length > 0;
}

async function collectionName(provider: ethers.Provider, collection: string): Promise<string | null> {
  const nft = new ethers.Contract(collection, ['function name() view returns (string)'], provider);
  const name = await nft.name().catch(() => null);
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long the hand-off route waits for the server's RPC to see a transaction the wallet's RPC already confirmed. */
export const RECEIPT_WAIT_MS = 6000;
const RECEIPT_POLL_MS = 1500;

/**
 * Record a transaction a connected wallet signed. Returns false when it is not
 * recorded: not mined or failed, older than `maxAgeS` (RECORD_WINDOW_S for a
 * hash a page hands over; null for one read from the explorer, which is
 * Flizy activity whatever its age), not Flizy activity, already logged by
 * Flizy or sent by a Flizy wallet (whose own route logs it), a deposit to a
 * wallet that is not a Flizy account's, or already on record.
 *
 * `waitMs` covers the moment right after a page hands a hash over: its wallet
 * saw the receipt, but the RPC this server reads may not have it yet.
 */
export async function recordWalletTx(args: {
  provider: ethers.Provider;
  supabase: Db;
  txHash: string;
  chainId: number;
  setup: ScanSetup;
  now?: number;
  maxAgeS?: number | null;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const { provider, supabase, setup } = args;
  const maxAgeS = args.maxAgeS === undefined ? RECORD_WINDOW_S : args.maxAgeS;
  const sleep = args.sleep ?? pause;
  let waited = 0;
  let [tx, receipt] = await Promise.all([provider.getTransaction(args.txHash), provider.getTransactionReceipt(args.txHash)]);
  while ((!tx || !receipt) && waited < (args.waitMs ?? 0)) {
    await sleep(RECEIPT_POLL_MS);
    waited += RECEIPT_POLL_MS;
    [tx, receipt] = await Promise.all([provider.getTransaction(args.txHash), provider.getTransactionReceipt(args.txHash)]);
  }
  if (!tx || !receipt || receipt.status !== 1) return false;
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) return false;
  if (maxAgeS != null && (args.now ?? Date.now()) / 1000 - block.timestamp > maxAgeS) return false;

  const move = readWalletMove(
    { from: tx.from, to: tx.to, value: tx.value, data: tx.data, logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) },
    setup
  );
  if (!move) return false;
  if (await loggedByFlizy(supabase, args.txHash)) return false;
  if (await isFlizyWallet(supabase, move.wallet)) return false;
  if (move.kind === 'deposit' && !(await isFlizyWallet(supabase, move.to))) return false;

  const collection = moveCollection(move);
  const row = walletScanRow(move, {
    txHash: args.txHash,
    chainId: args.chainId,
    at: new Date(block.timestamp * 1000),
    collectionName: collection ? await collectionName(provider, collection) : null,
  });
  const { error } = await supabase.from('transfers').insert(row);
  // 23505: the unique index already holds this hash.
  if (error) {
    if ((error as { code?: string }).code === '23505') return false;
    throw new Error(error.message);
  }
  return true;
}

/** Contract methods whose transactions are Flizy activity, as the explorer names them. */
const ROUTER_METHODS = new Set(['swapExactETHForTokens', 'swapExactTokensForETH', 'swapExactTokensForTokens']);
const MARKET_METHODS = new Set(['list', 'cancelListing', 'buy', 'makeOffer', 'cancelOffer', 'acceptOffer', 'setRoyalty', 'withdraw']);

/**
 * New rows one sync may write, how long it may keep starting new ones, and
 * how many it reads at once. The explorer takes a few seconds to answer and a
 * row a few chain reads, measured against GIWA Sepolia.
 */
export const SYNC_MAX_NEW = 12;
export const SYNC_BUDGET_MS = 25_000;
const SYNC_PARALLEL = 4;
const EXPLORER_TIMEOUT_MS = 12_000;

type ExplorerTx = { hash?: unknown; status?: unknown; method?: unknown };

/**
 * Hashes this server instance already read and did not record, such as a swap
 * of a token Flizy does not list. Kept so each sync spends its budget on new
 * transactions; bounded, and empty again on a fresh instance.
 */
const declined = new Set<string>();
const DECLINED_MAX = 1000;

/** Hashes of the latest successful calls to `address` with one of `methods`, newest first. */
async function explorerCalls(
  explorerUrl: string,
  address: string,
  methods: Set<string>,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const res = await fetchImpl(`${explorerUrl}/api/v2/addresses/${address}/transactions?filter=to`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { items?: ExplorerTx[] } | null;
  const hashes: string[] = [];
  for (const item of body?.items ?? []) {
    const hash = typeof item.hash === 'string' ? item.hash.toLowerCase() : '';
    // The explorer only points at candidates: each one is read again from the chain before it is recorded.
    if (/^0x[0-9a-f]{64}$/.test(hash) && item.status === 'ok' && typeof item.method === 'string' && methods.has(item.method)) {
      hashes.push(hash);
    }
  }
  return hashes;
}

/**
 * Put every recent swap through Flizy's fee router and every marketplace
 * action on Scan, whoever signed it: the page's hand-off misses a trade when
 * the tab closes first or the server's RPC lags, and someone with no Flizy
 * account at all trades through the same contracts. The explorer lists the
 * latest calls to each contract; hashes already in transfers are skipped, and
 * the rest go through recordWalletTx with no age limit. Flizy wallets' own
 * trades are logged by their routes and are skipped there too.
 *
 * Bounded by SYNC_MAX_NEW and SYNC_BUDGET_MS; whatever is left is picked up by
 * the next sync. Returns how many rows it wrote.
 */
export async function syncWalletScan(args: {
  provider: ethers.Provider;
  supabase: Db;
  chainId: number;
  setup: ScanSetup;
  explorerUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<number> {
  const { setup, supabase } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const started = now();
  const lists = await Promise.all([
    explorerCalls(args.explorerUrl, setup.feeRouter, ROUTER_METHODS, fetchImpl).catch(() => []),
    setup.market ? explorerCalls(args.explorerUrl, setup.market, MARKET_METHODS, fetchImpl).catch(() => []) : Promise.resolve([]),
  ]);
  const candidates = [...new Set(lists.flat())];
  if (!candidates.length) return 0;

  const { data, error } = await supabase.from('transfers').select('tx_hash').in('tx_hash', candidates);
  if (error) throw new Error(error.message);
  const known = new Set((data || []).map((row: { tx_hash?: string | null }) => String(row.tx_hash || '').toLowerCase()));

  const pending = candidates.filter((txHash) => !known.has(txHash) && !declined.has(txHash));
  let written = 0;
  // Newest first, a few at a time, so one sync never writes much past SYNC_MAX_NEW.
  let next = 0;
  while (next < pending.length && written < SYNC_MAX_NEW && now() - started <= SYNC_BUDGET_MS) {
    const batch = pending.slice(next, next + Math.min(SYNC_PARALLEL, SYNC_MAX_NEW - written));
    next += batch.length;
    const results = await Promise.all(
      batch.map((txHash) =>
        recordWalletTx({ provider: args.provider, supabase, txHash, chainId: args.chainId, setup, maxAgeS: null }).then(
          (recorded) => ({ txHash, recorded }),
          // One unreadable transaction does not stop the rest; the next sync tries it again.
          () => ({ txHash, recorded: null })
        )
      )
    );
    for (const { txHash, recorded } of results) {
      if (recorded) written += 1;
      else if (recorded === false) {
        if (declined.size >= DECLINED_MAX) declined.clear();
        declined.add(txHash);
      }
    }
  }
  return written;
}
