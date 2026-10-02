/**
 * NFT index: what the GIWA explorer (Blockscout v2) knows about collections,
 * tokens, holders and transfers.
 *
 * The explorer is a read model, not an authority. Ownership and prices that
 * decide a trade are re-read from the chain by the trading routes; this module
 * only lists and describes. Every field is validated here, so a malformed or
 * hostile explorer response turns into a missing value, never a wrong one.
 *
 * The base URL comes from the chain config, never from a request. Paths are
 * built only from checksummed addresses and digit-only token ids.
 */

import { ethers } from 'ethers';

export type NftStandard = 'ERC-721' | 'ERC-1155';

export type CollectionSummary = {
  address: string;
  name: string;
  symbol: string | null;
  standard: NftStandard;
  holders: number | null;
  supply: string | null;
  icon: string | null;
};

export type NftTrait = { trait: string; value: string };

export type NftItem = {
  collection: string;
  tokenId: string;
  name: string | null;
  description: string | null;
  image: string | null;
  owner: string | null;
  traits: NftTrait[];
  externalUrl: string | null;
};

export type WalletNft = NftItem & { standard: NftStandard; collectionName: string; amount: string };

export type TransferRow = {
  tokenId: string;
  from: string;
  to: string;
  kind: 'mint' | 'transfer' | 'burn';
  txHash: string;
  timestamp: string | null;
};

export type HolderRow = { address: string; count: number };

export type Page<T> = { items: T[]; next: string | null };

const ZERO = ethers.ZeroAddress;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_ID = /^[0-9]{1,78}$/;
const MAX_BODY = 2_000_000;
const MAX_TEXT = 500;
const MAX_TRAITS = 50;
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

// ----------------------------------------------------------------- validation

export function checkAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || !ethers.isAddress(raw)) return null;
  return ethers.getAddress(raw);
}

export function checkTokenId(raw: unknown): string | null {
  const text = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof text !== 'string' || !TOKEN_ID.test(text)) return null;
  // Strip leading zeros so "007" and "7" are the same token.
  return BigInt(text).toString();
}

function text(raw: unknown, max = MAX_TEXT): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function count(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw);
  if (!/^[0-9]{1,12}$/.test(value)) return null;
  return Number(value);
}

function bigText(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw);
  return /^[0-9]{1,78}$/.test(value) ? BigInt(value).toString() : null;
}

/**
 * An image the page may load: https, ipfs (through a public gateway) or a small
 * inline raster/SVG. Anything else, including http, is dropped. Images render
 * in <img>, where SVG scripts do not run.
 */
export function safeImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.startsWith('data:')) {
    return /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(value) && value.length <= 200_000 ? value : null;
  }
  if (value.length > 2048) return null;
  if (value.startsWith('ipfs://')) {
    const path = value.slice('ipfs://'.length).replace(/^ipfs\//, '');
    return /^[A-Za-z0-9][A-Za-z0-9._\-/%]*$/.test(path) ? `${IPFS_GATEWAY}${path}` : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function standard(raw: unknown): NftStandard | null {
  return raw === 'ERC-721' || raw === 'ERC-1155' ? raw : null;
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function items(body: unknown): unknown[] {
  const o = obj(body);
  return o && Array.isArray(o.items) ? o.items : [];
}

function hashOf(raw: unknown): string | null {
  return checkAddress(obj(raw)?.hash);
}

// -------------------------------------------------------------------- parsers

export function parseCollection(raw: unknown): CollectionSummary | null {
  const o = obj(raw);
  if (!o) return null;
  const address = checkAddress(o.address_hash ?? o.address);
  const kind = standard(o.type);
  if (!address || !kind) return null;
  return {
    address,
    name: text(o.name, 64) || shortAddress(address),
    symbol: text(o.symbol, 16),
    standard: kind,
    holders: count(o.holders_count),
    supply: bigText(o.total_supply),
    icon: safeImageUrl(o.icon_url),
  };
}

function parseCollections(body: unknown): CollectionSummary[] {
  return items(body)
    .map(parseCollection)
    .filter((c): c is CollectionSummary => c != null);
}

function parseTraits(raw: unknown): NftTrait[] {
  if (!Array.isArray(raw)) return [];
  const out: NftTrait[] = [];
  for (const entry of raw) {
    const o = obj(entry);
    if (!o) continue;
    const trait = text(o.trait_type, 40);
    const value = text(o.value, 80);
    if (!trait || !value) continue;
    out.push({ trait, value });
    if (out.length >= MAX_TRAITS) break;
  }
  return out;
}

/** One token instance. `collection` is the address it was asked for. */
export function parseInstance(raw: unknown, collection: string): NftItem | null {
  const o = obj(raw);
  if (!o) return null;
  const tokenId = checkTokenId(o.id);
  if (!tokenId) return null;
  const meta = obj(o.metadata);
  return {
    collection,
    tokenId,
    name: text(meta?.name, 80),
    description: text(meta?.description, 1000),
    image: safeImageUrl(o.image_url) || safeImageUrl(meta?.image) || safeImageUrl(meta?.image_url),
    owner: hashOf(o.owner),
    traits: parseTraits(meta?.attributes),
    externalUrl: safeLink(meta?.external_url ?? meta?.url),
  };
}

function parseInstances(body: unknown, collection: string): NftItem[] {
  return items(body)
    .map((row) => parseInstance(row, collection))
    .filter((row): row is NftItem => row != null);
}

export function parseWalletNfts(body: unknown, owner: string): WalletNft[] {
  const out: WalletNft[] = [];
  for (const row of items(body)) {
    const o = obj(row);
    const col = parseCollection(o?.token);
    if (!o || !col) continue;
    const item = parseInstance(o, col.address);
    if (!item) continue;
    out.push({
      ...item,
      owner: item.owner || owner,
      standard: col.standard,
      collectionName: col.name,
      amount: bigText(o.value) || '1',
    });
  }
  return out;
}

export function parseTransfers(body: unknown): TransferRow[] {
  const out: TransferRow[] = [];
  for (const row of items(body)) {
    const o = obj(row);
    if (!o) continue;
    const tokenId = checkTokenId(obj(o.total)?.token_id);
    const from = hashOf(o.from);
    const to = hashOf(o.to);
    const txHash = typeof o.transaction_hash === 'string' && HASH.test(o.transaction_hash) ? o.transaction_hash : null;
    if (!tokenId || !from || !to || !txHash) continue;
    const kind = from === ZERO ? 'mint' : to === ZERO ? 'burn' : 'transfer';
    const timestamp = typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp)) ? o.timestamp : null;
    out.push({ tokenId, from, to, kind, txHash, timestamp });
  }
  return out;
}

export function parseHolders(body: unknown): HolderRow[] {
  const out: HolderRow[] = [];
  for (const row of items(body)) {
    const o = obj(row);
    const address = hashOf(o?.address);
    const held = count(o?.value);
    if (!address || held == null || held === 0) continue;
    out.push({ address, count: held });
  }
  return out;
}

/**
 * The explorer's next-page cursor, taken from the raw response text. Parsing
 * it as JSON would round 78-digit token ids, so the values are kept as written
 * and only keys and plain scalars pass.
 */
export function nextCursor(rawText: string): string | null {
  const match = rawText.match(/"next_page_params"\s*:\s*(\{[^{}]*\}|null)/);
  if (!match || match[1] === 'null') return null;
  const params = new URLSearchParams();
  const pair = /"([A-Za-z_]{1,40})"\s*:\s*("([^"\\]{0,200})"|-?[0-9.eE+]{1,100}|true|false|null)/g;
  let found: RegExpExecArray | null;
  while ((found = pair.exec(match[1]))) {
    const value = found[3] !== undefined ? found[3] : found[2];
    if (value === 'null') continue;
    params.set(found[1], value);
  }
  const query = params.toString();
  return query ? query : null;
}

/** A cursor coming back from the browser: only what nextCursor could produce. */
export function checkCursor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 1000) return null;
  const params = new URLSearchParams(raw);
  const clean = new URLSearchParams();
  for (const [key, value] of params) {
    if (!/^[A-Za-z_]{1,40}$/.test(key) || value.length > 200 || /[\u0000-\u001f]/.test(value)) return null;
    clean.set(key, value);
  }
  const query = clean.toString();
  return query || null;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ---------------------------------------------------------------------- fetch

type CacheEntry = { at: number; value: unknown };
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 400;
const cache = new Map<string, CacheEntry>();

function cached<T>(key: string, now: number): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function remember(key: string, value: unknown, now: number) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: now, value });
}

export type ExplorerFetch = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetch: ExplorerFetch = (url) =>
  fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });

export class NftIndex {
  readonly api: string;
  private readonly fetcher: ExplorerFetch;

  constructor(explorerBaseUrl: string, fetcher: ExplorerFetch = defaultFetch) {
    this.fetcher = fetcher;
    if (!/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/i.test(explorerBaseUrl.replace(/\/$/, ''))) {
      throw new Error('NFT index needs an https explorer');
    }
    this.api = `${explorerBaseUrl.replace(/\/$/, '')}/api/v2`;
  }

  private async get(path: string, query?: Record<string, string>, cursor?: string | null) {
    const params = new URLSearchParams(cursor || '');
    for (const [k, v] of Object.entries(query || {})) params.set(k, v);
    const qs = params.toString();
    const url = `${this.api}${path}${qs ? `?${qs}` : ''}`;
    const now = Date.now();
    const hit = cached<{ body: unknown; next: string | null }>(url, now);
    if (hit) return hit;
    const res = await this.fetcher(url);
    if (res.status === 404) return { body: null, next: null };
    if (!res.ok) throw new Error('NFT index unavailable');
    const raw = await res.text();
    if (raw.length > MAX_BODY) throw new Error('NFT index response too large');
    const value = { body: JSON.parse(raw) as unknown, next: nextCursor(raw) };
    remember(url, value, now);
    return value;
  }

  async collection(address: string): Promise<CollectionSummary | null> {
    const { body } = await this.get(`/tokens/${address}`);
    return parseCollection(body);
  }

  async searchCollections(q: string, cursor?: string | null): Promise<Page<CollectionSummary>> {
    const query: Record<string, string> = { type: 'ERC-721,ERC-1155' };
    const term = q.trim().slice(0, 64);
    if (term) query.q = term;
    const { body, next } = await this.get('/tokens', query, cursor);
    return { items: parseCollections(body), next };
  }

  async instances(address: string, cursor?: string | null): Promise<Page<NftItem>> {
    const { body, next } = await this.get(`/tokens/${address}/instances`, undefined, cursor);
    return { items: parseInstances(body, address), next };
  }

  async instance(address: string, tokenId: string): Promise<NftItem | null> {
    const { body } = await this.get(`/tokens/${address}/instances/${tokenId}`);
    return body ? parseInstance(body, address) : null;
  }

  async holders(address: string, cursor?: string | null): Promise<Page<HolderRow>> {
    const { body, next } = await this.get(`/tokens/${address}/holders`, undefined, cursor);
    return { items: parseHolders(body), next };
  }

  async transfers(address: string, cursor?: string | null): Promise<Page<TransferRow>> {
    const { body, next } = await this.get(`/tokens/${address}/transfers`, undefined, cursor);
    return { items: parseTransfers(body), next };
  }

  async tokenTransfers(address: string, tokenId: string, cursor?: string | null): Promise<Page<TransferRow>> {
    const { body, next } = await this.get(`/tokens/${address}/instances/${tokenId}/transfers`, undefined, cursor);
    return { items: parseTransfers(body), next };
  }

  async walletNfts(wallet: string, cursor?: string | null): Promise<Page<WalletNft>> {
    const { body, next } = await this.get(`/addresses/${wallet}/nft`, { type: 'ERC-721,ERC-1155' }, cursor);
    return { items: parseWalletNfts(body, wallet), next };
  }

  /** Who deployed the collection and when, for the About tab and the date chip. */
  async creation(address: string): Promise<{ creator: string | null; createdAt: string | null }> {
    const { body } = await this.get(`/addresses/${address}`);
    const o = obj(body);
    const creator = checkAddress(o?.creator_address_hash);
    const tx = typeof o?.creation_transaction_hash === 'string' && HASH.test(o.creation_transaction_hash)
      ? o.creation_transaction_hash
      : null;
    if (!tx) return { creator, createdAt: null };
    const { body: txBody } = await this.get(`/transactions/${tx}`);
    const ts = obj(txBody)?.timestamp;
    return { creator, createdAt: typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? ts : null };
  }

  /** Raw event logs emitted by `address`, newest first. */
  async logs(address: string, cursor?: string | null): Promise<Page<RawLog>> {
    const { body, next } = await this.get(`/addresses/${address}/logs`, undefined, cursor);
    return { items: parseLogs(body), next };
  }
}

export type RawLog = {
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  timestamp: string | null;
};

export function parseLogs(body: unknown): RawLog[] {
  const out: RawLog[] = [];
  for (const row of items(body)) {
    const o = obj(row);
    if (!o || !Array.isArray(o.topics)) continue;
    const topics = o.topics.filter((t): t is string => typeof t === 'string' && HASH.test(t));
    const data = typeof o.data === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(o.data) ? o.data : null;
    const blockNumber = typeof o.block_number === 'number' && Number.isSafeInteger(o.block_number) ? o.block_number : null;
    const logIndex = typeof o.index === 'number' && Number.isSafeInteger(o.index) ? o.index : null;
    const txHash = typeof o.transaction_hash === 'string' && HASH.test(o.transaction_hash) ? o.transaction_hash : null;
    if (!topics.length || data == null || blockNumber == null || logIndex == null || !txHash) continue;
    const ts = typeof o.block_timestamp === 'string' && !Number.isNaN(Date.parse(o.block_timestamp)) ? o.block_timestamp : null;
    out.push({ topics, data, blockNumber, logIndex, txHash, timestamp: ts });
  }
  return out;
}

let shared: NftIndex | null = null;

/** The index for the configured explorer. */
export function nftIndex(explorerBaseUrl: string): NftIndex {
  if (!shared || shared.api !== `${explorerBaseUrl.replace(/\/$/, '')}/api/v2`) {
    shared = new NftIndex(explorerBaseUrl);
  }
  return shared;
}
