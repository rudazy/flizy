/**
 * Ammora tokens as the site shows them (Explore and the swap token picker).
 *
 * Tokens come from the bot's inventory (ammora_pools: discovered on chain,
 * name, symbol and decimals read from the token contract). Launch status comes
 * from the Data API, fetched server side with a timeout and a short cache; if
 * it cannot be read, the list is empty and says so, and nothing else on the
 * page is affected. Every name and symbol goes through displaySafeLabel.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ethers } from 'ethers';
import { displaySafeLabel } from '../sanitize.ts';
import { LISTED_TOKENS } from '../listedTokens.ts';
import { AMMORA_CHAIN_ID, shortAddress } from './venue.ts';
import { ensureAttested } from './attest.ts';
import { loadInventory, type InventoryToken } from './routes.ts';

const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_DATA_API = 'https://ammora-giwa-sepolia-data.fly.dev';

export type AmmoraTokenView = {
  address: string;
  symbol: string;
  name: string;
  decimals: number | null;
  status: 'active' | 'migrated' | 'ready to migrate' | 'unknown';
  tradable: boolean;
  label: string;
  source: 'Ammora launch';
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
let statusCache: { at: number; map: Map<string, string> } | null = null;

/** Launch status by token address, from the Data API. Throws on any failure. */
async function launchStatuses(opts: { fetcher?: Fetcher; now?: number; baseUrl?: string } = {}): Promise<Map<string, string>> {
  const now = opts.now ?? Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.map;
  const fetcher = opts.fetcher || (fetch as unknown as Fetcher);
  const base = (opts.baseUrl || process.env.AMMORA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/+$/, '');
  const map = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const url = `${base}/v1/tokens?chainId=${AMMORA_CHAIN_ID}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), cache: 'no-store' } as RequestInit);
    if (!res.ok) throw new Error('Data API unavailable');
    const body = (await res.json()) as { items?: Array<{ address?: string; status?: string; blacklisted?: boolean }>; nextCursor?: string | null };
    for (const item of body.items || []) {
      if (item.address) map.set(String(item.address).toLowerCase(), item.blacklisted ? 'FLAGGED' : String(item.status || ''));
    }
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  statusCache = { at: now, map };
  return map;
}

export function resetCatalogCache(): void {
  statusCache = null;
}

/** One token as the site shows it. */
export function toView(t: InventoryToken, status: string | undefined): AmmoraTokenView {
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
  };
}

/**
 * The Ammora tokens to show. Flagged launches are left out. Empty, with
 * unavailable: true, when the venue is off or the Data API cannot be read.
 */
export async function listAmmoraTokens(
  supabase: SupabaseClient,
  provider: ethers.Provider,
  opts: { fetcher?: Fetcher; now?: number } = {}
): Promise<AmmoraCatalog> {
  try {
    const attested = await ensureAttested(provider);
    if (!attested.ok) return { tokens: [], unavailable: true };
    const [inventory, statuses] = await Promise.all([loadInventory(supabase), launchStatuses(opts)]);
    const tokens = inventory
      .filter((t) => statuses.get(t.baseToken.toLowerCase()) !== 'FLAGGED')
      .map((t) => toView(t, statuses.get(t.baseToken.toLowerCase())))
      .sort((a, b) => Number(b.tradable) - Number(a.tradable) || a.symbol.localeCompare(b.symbol));
    return { tokens, unavailable: false };
  } catch {
    return { tokens: [], unavailable: true };
  }
}
