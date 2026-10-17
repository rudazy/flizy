/**
 * Ammora tokens as the site shows them (Explore and the swap token picker).
 *
 * Tokens come from the bot's inventory (ammora_pools: discovered on chain,
 * name, symbol and decimals read from the token contract). Launch status comes
 * from the Data API when it answers, fetched server side with a timeout and a
 * short cache. When that read fails, each pool's stored launch status is used.
 * A launch flagged after that status was written can stay listed until the API
 * answers again. Flagged launches are left out either way. The list is empty
 * and says so only when the venue is off or the inventory cannot be read.
 * Every name and symbol goes through displaySafeLabel. A logo is the image
 * Ammora published for that token: the token-assets logo, or the image named
 * by Ammora's own media metadata. Any other URL is left out.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ethers } from 'ethers';
import { displaySafeLabel } from '../sanitize.ts';
import { safeImageUrl } from '../nftIndex.ts';
import { LISTED_TOKENS } from '../listedTokens.ts';
import { AMMORA_CHAIN_ID, shortAddress } from './venue.ts';
import { ensureAttested } from './attest.ts';
import { loadInventory, type InventoryToken } from './routes.ts';

const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_DATA_API = 'https://ammora-giwa-sepolia-data.fly.dev';
/** Metadata Ammora's own app published. Anything else is not fetched. */
const MEDIA_METADATA = /^https:\/\/app\.ammora\.org\/api\/media\/token\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/metadata$/i;

export type AmmoraTokenView = {
  address: string;
  symbol: string;
  name: string;
  decimals: number | null;
  status: 'active' | 'migrated' | 'ready to migrate' | 'unknown';
  tradable: boolean;
  label: string;
  source: 'Ammora launch';
  /** https or ipfs image, or null when Ammora has no logo for this token. */
  image: string | null;
};

export type AmmoraCatalog = { tokens: AmmoraTokenView[]; unavailable: boolean };

/** Every symbol Flizy itself means: these always resolve to Flizy's tokens. */
export function flizySymbols(): string[] {
  return ['ETH', 'WETH', 'FLZ', 'FLIZY', 'NATIVE', ...LISTED_TOKENS.map((t) => t.symbol)];
}

/**
 * Ammora tokens the wallet should read a balance for: every stored pool's
 * token, symbol sanitized. No Data API call and no attestation (a balance read
 * moves nothing), so the wallet still shows a holding while the venue is off.
 */
export async function ammoraHoldingCandidates(
  supabase: SupabaseClient
): Promise<Array<{ address: string; symbol: string; decimals: number | null }>> {
  const inventory = await loadInventory(supabase);
  return inventory.map((t) => ({
    address: t.baseToken,
    symbol: displaySafeLabel(t.symbol || 'TOKEN', 16) || 'TOKEN',
    decimals: t.decimals,
  }));
}

const STATUS_TEXT: Record<string, AmmoraTokenView['status']> = {
  ACTIVE: 'active',
  MIGRATED: 'migrated',
  MIGRATION_READY: 'ready to migrate',
};

type Fetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
type LiveLaunches = { statuses: Map<string, string>; metadata: Map<string, string> };
let statusCache: { at: number; read: LiveLaunches } | null = null;
let imageCache: { at: number; map: Map<string, string> } | null = null;

/** Launch status and metadata URI by token address. Throws on any failure. */
async function launchStatuses(opts: { fetcher?: Fetcher; now?: number; baseUrl?: string } = {}): Promise<LiveLaunches> {
  const now = opts.now ?? Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.read;
  const fetcher = opts.fetcher || (fetch as unknown as Fetcher);
  const base = (opts.baseUrl || process.env.AMMORA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/+$/, '');
  const statuses = new Map<string, string>();
  const metadata = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const url = `${base}/v1/tokens?chainId=${AMMORA_CHAIN_ID}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), cache: 'no-store' } as RequestInit);
    if (!res.ok) throw new Error('Data API unavailable');
    const body = (await res.json()) as {
      items?: Array<{ address?: string; status?: string; blacklisted?: boolean; metadataUri?: unknown }>;
      nextCursor?: string | null;
    };
    for (const item of body.items || []) {
      if (!item.address) continue;
      const key = String(item.address).toLowerCase();
      statuses.set(key, item.blacklisted ? 'FLAGGED' : String(item.status || ''));
      if (typeof item.metadataUri === 'string' && item.metadataUri) metadata.set(key, item.metadataUri);
    }
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  const read = { statuses, metadata };
  statusCache = { at: now, read };
  return read;
}

export function resetCatalogCache(): void {
  statusCache = null;
  imageCache = null;
}

/** Logos from /v1/token-assets. A missing or unsafe URL is left out. Throws when the read fails. */
async function tokenImages(addresses: string[], opts: { fetcher?: Fetcher; baseUrl?: string } = {}): Promise<Map<string, string>> {
  const fetcher = opts.fetcher || (fetch as unknown as Fetcher);
  const base = (opts.baseUrl || process.env.AMMORA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/+$/, '');
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
  const map = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 100) {
    const batch = wanted.slice(i, i + 100);
    const url = `${base}/v1/token-assets?chainId=${AMMORA_CHAIN_ID}&addresses=${batch.join(',')}`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), cache: 'no-store' } as RequestInit);
    if (!res.ok) throw new Error('Data API unavailable');
    const body = (await res.json()) as { items?: Array<{ address?: string; logoUrl?: unknown }> };
    for (const item of body.items || []) {
      const logo = safeImageUrl(item.logoUrl);
      if (item.address && logo) map.set(String(item.address).toLowerCase(), logo);
    }
  }
  return map;
}

/** Image named by Ammora's media metadata. A token that already has a logo is left as it is. */
async function fillFromMetadata(metadata: Map<string, string>, images: Map<string, string>, opts: { fetcher?: Fetcher } = {}): Promise<void> {
  const fetcher = opts.fetcher || (fetch as unknown as Fetcher);
  const jobs = [...metadata.entries()].filter(([address, uri]) => !images.has(address) && MEDIA_METADATA.test(uri)).slice(0, 100);
  await Promise.all(jobs.map(async ([address, uri]) => {
    try {
      const res = await fetcher(uri, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), redirect: 'error', cache: 'no-store' } as RequestInit);
      if (!res.ok) return;
      const body = (await res.json()) as { image?: unknown; image_url?: unknown };
      const image = safeImageUrl(body.image) || safeImageUrl(body.image_url);
      if (image) images.set(address, image);
    } catch {
      /* this token keeps the letter */
    }
  }));
}

/** Logo by token address. A token-assets logo wins. Metadata fills the rest. */
async function resolveImages(addresses: string[], metadata: Map<string, string>, opts: { fetcher?: Fetcher; now?: number; baseUrl?: string } = {}): Promise<Map<string, string>> {
  const now = opts.now ?? Date.now();
  if (imageCache && now - imageCache.at < STATUS_TTL_MS) return imageCache.map;
  let images = new Map<string, string>();
  try {
    images = await tokenImages(addresses, opts);
  } catch {
    images = new Map();
  }
  await fillFromMetadata(metadata, images, opts);
  imageCache = { at: now, map: images };
  return images;
}

/** One token as the site shows it. */
export function toView(t: InventoryToken, status: string | undefined, image?: string | null): AmmoraTokenView {
  const symbol = displaySafeLabel(t.symbol || '', 16) || 'token';
  return {
    address: t.baseToken,
    symbol,
    name: displaySafeLabel(t.name || '', 40),
    decimals: t.decimals,
    status: STATUS_TEXT[String(status)] || 'unknown',
    tradable: t.tradable && status === 'ACTIVE',
    label: `${symbol} (${shortAddress(t.baseToken)}, Ammora)`,
    source: 'Ammora launch',
    image: image || null,
  };
}

/** Last launch status the inventory job stored, keyed by token address. */
function storedStatuses(inventory: InventoryToken[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of inventory) {
    if (t.launchStatus) map.set(t.baseToken.toLowerCase(), t.launchStatus);
  }
  return map;
}

function project(inventory: InventoryToken[], statuses: Map<string, string>, images: Map<string, string>): AmmoraTokenView[] {
  return inventory
    .filter((t) => statuses.get(t.baseToken.toLowerCase()) !== 'FLAGGED')
    .map((t) => toView(t, statuses.get(t.baseToken.toLowerCase()), images.get(t.baseToken.toLowerCase())))
    .sort((a, b) => Number(b.tradable) - Number(a.tradable) || a.symbol.localeCompare(b.symbol));
}

/**
 * The Ammora tokens to show. Flagged launches are left out. A live Data API
 * status wins. When that read fails, each pool's stored launch status is used.
 * Empty, with unavailable: true, when the venue is off or the inventory cannot
 * be read.
 */
export async function listAmmoraTokens(
  supabase: SupabaseClient,
  provider: ethers.Provider,
  opts: { fetcher?: Fetcher; now?: number } = {}
): Promise<AmmoraCatalog> {
  try {
    const attested = await ensureAttested(provider);
    if (!attested.ok) return { tokens: [], unavailable: true };
    const inventoryPromise = loadInventory(supabase);
    const livePromise = launchStatuses(opts).then(
      (read) => read,
      () => null as LiveLaunches | null
    );
    const [inventory, live] = await Promise.all([inventoryPromise, livePromise]);
    if (!live) console.warn('[ammora] data API unread, using stored launch status');
    const statuses = live ? live.statuses : storedStatuses(inventory);
    let images = new Map<string, string>();
    if (live) {
      const shown = inventory.filter((t) => statuses.get(t.baseToken.toLowerCase()) !== 'FLAGGED');
      const metadata = new Map<string, string>();
      for (const token of shown) {
        const uri = live.metadata.get(token.baseToken.toLowerCase());
        if (uri) metadata.set(token.baseToken.toLowerCase(), uri);
      }
      images = await resolveImages(shown.map((t) => t.baseToken), metadata, opts);
    }
    return { tokens: project(inventory, statuses, images), unavailable: false };
  } catch {
    return { tokens: [], unavailable: true };
  }
}
