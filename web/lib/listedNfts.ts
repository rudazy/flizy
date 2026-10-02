/**
 * Listed NFT collections for identity send / wallet display.
 * Mirrors lib/listedNfts.js env parse. Empty env falls back to the testnet giwaforge.
 */

import { ethers } from 'ethers';

const DEFAULT_GIWAFORGE = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';

const ERC721_META_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export type ListedNft = { ticker: string; address: string };

export type NftHolding = {
  ticker: string;
  address: string;
  balance: string | null;
  ids: string[];
  error?: string;
};

export function parseNftRegistry(raw: string): ListedNft[] {
  const out: ListedNft[] = [];
  const seen = new Set<string>();
  for (const part of String(raw || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    if (idx <= 0) continue;
    const ticker = s.slice(0, idx).trim().toLowerCase();
    const addr = s.slice(idx + 1).trim();
    if (!/^[a-z][a-z0-9]{0,31}$/.test(ticker)) continue;
    if (!ethers.isAddress(addr)) continue;
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, address: ethers.getAddress(addr) });
  }
  return out;
}

export function listedNfts(): ListedNft[] {
  const fromEnv = parseNftRegistry(process.env.CHAIN_GIWA_SEPOLIA_NFTS || '');
  if (fromEnv.length) return fromEnv;
  return [{ ticker: 'giwaforge', address: ethers.getAddress(DEFAULT_GIWAFORGE) }];
}

/**
 * What a verified collection's page shows beyond the chain: the words, the art
 * and who made it. Keyed by ticker. A listed ticker without a profile still
 * shows as verified, with the explorer's name and no banner.
 */
export type CollectionProfile = {
  description: string;
  banner: string | null;
  avatar: string | null;
  creator: string;
  category: string | null;
};

const PROFILES: Record<string, CollectionProfile> = {
  giwaforge: {
    description:
      'Giwaforge is the Flizy test collection on GIWA Sepolia: 500 NFTs, one free claim per wallet. ' +
      'Holders can send theirs to anyone on WhatsApp or Telegram, by phone number, email or username, ' +
      'and trade them here.',
    banner: '/explore/nft-giwaforge.png',
    avatar: '/explore/nft-giwaforge-avatar.png',
    creator: 'Flizy',
    category: 'Test',
  },
};

export type VerifiedCollection = ListedNft & { profile: CollectionProfile | null };

/** The registry entry for an address, or null when Flizy has not verified it. */
export function verifiedCollection(address: string): VerifiedCollection | null {
  if (!ethers.isAddress(address)) return null;
  const target = ethers.getAddress(address);
  const hit = listedNfts().find((col) => col.address === target);
  return hit ? { ...hit, profile: PROFILES[hit.ticker] ?? null } : null;
}

export async function loadNftHoldings(
  provider: ethers.Provider,
  wallet: string
): Promise<NftHolding[]> {
  const out: NftHolding[] = [];
  for (const col of listedNfts()) {
    try {
      const nft = new ethers.Contract(col.address, ERC721_META_ABI, provider);
      const bal = await nft.balanceOf(wallet);
      const count = Number(bal);
      // A listed collection you hold none of is not a holding. This mirrors
      // lib/holdings.js loadNftHoldings, which has always dropped them; this
      // copy had lost the filter, which is why the wallet showed "giwaforge 0".
      // A collection that could not be READ is different and is still reported
      // by the catch below, so "none" is never confused with "do not know".
      if (!Number.isFinite(count) || count <= 0) continue;
      let ids: string[] = [];
      if (count > 0) {
        try {
          const incoming = await nft.queryFilter(nft.filters.Transfer(null, wallet));
          const owned = new Set<string>();
          for (const ev of incoming) {
            if (!('args' in ev) || ev.args?.tokenId == null) continue;
            owned.add(ev.args.tokenId.toString());
          }
          const outgoing = await nft.queryFilter(nft.filters.Transfer(wallet, null));
          for (const ev of outgoing) {
            if (!('args' in ev) || ev.args?.tokenId == null) continue;
            owned.delete(ev.args.tokenId.toString());
          }
          ids = [...owned].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        } catch {
          ids = [];
        }
      }
      out.push({
        ticker: col.ticker,
        address: col.address,
        balance: String(count),
        ids,
      });
    } catch {
      out.push({
        ticker: col.ticker,
        address: col.address,
        balance: null,
        ids: [],
        error: 'Could not read NFT',
      });
    }
  }
  return out;
}

export function formatNftHoldingLine(n: NftHolding): string {
  if (n.balance == null) return `${n.ticker}: unavailable`;
  if (n.ids.length) return `${n.ticker} ${n.ids.map((id) => `#${id}`).join(', ')}`;
  return `${n.ticker}: ${n.balance}`;
}

const COLLECTION_ABI = [
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function claimed(address) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export type CollectionStats = {
  ticker: string;
  address: string;
  name: string;
  /** Tokens minted so far. */
  items: number | null;
  /** Distinct wallets holding at least one, from the Transfer history. */
  owners: number | null;
  /** True when the contract has the one-free-claim-per-wallet mint. */
  freeMint: boolean;
};

/** Stats are read from the chain; a minute old is fresh enough for a list. */
const STATS_TTL_MS = 60 * 1000;
const statsCache = new Map<string, { at: number; stats: CollectionStats }>();

/** The ownerOf fallback reads at most this many tokens, this many at a time. */
const OWNER_SCAN_MAX = 1000;
const OWNER_SCAN_BATCH = 50;

/**
 * What the Explore card shows for one listed collection, all read from the
 * contract. A figure that could not be read is null and shows as a dash, never
 * as a zero that would read like an answer.
 */
export async function loadCollectionStats(
  provider: ethers.Provider,
  col: ListedNft,
  now = Date.now()
): Promise<CollectionStats> {
  const hit = statsCache.get(col.address);
  if (hit && now - hit.at < STATS_TTL_MS) return hit.stats;

  const nft = new ethers.Contract(col.address, COLLECTION_ABI, provider);
  const [name, supply, claimProbe, transfers] = await Promise.all([
    nft.name().catch(() => null),
    nft.totalSupply().catch(() => null),
    nft.claimed(ethers.ZeroAddress).then(() => true).catch(() => false),
    nft.queryFilter(nft.filters.Transfer()).catch(() => null),
  ]);

  let owners: number | null = null;
  let minted: number | null = null;
  if (transfers) {
    const ownerOf = new Map<string, string>();
    for (const ev of transfers) {
      if (!('args' in ev) || ev.args?.tokenId == null) continue;
      ownerOf.set(ev.args.tokenId.toString(), String(ev.args.to).toLowerCase());
    }
    const zero = ethers.ZeroAddress.toLowerCase();
    owners = new Set([...ownerOf.values()].filter((a) => a !== zero)).size;
    minted = ownerOf.size;
  }

  // Some RPCs refuse a log query from genesis. Token ids here are minted in
  // order from 1, so asking each one who owns it gives the same answer, in
  // batches, up to a bound that keeps one request from becoming thousands.
  if (owners == null && supply != null && Number(supply) <= OWNER_SCAN_MAX) {
    const ids = Array.from({ length: Number(supply) }, (_, i) => i + 1);
    const holders = new Set<string>();
    let readAll = true;
    for (let i = 0; i < ids.length; i += OWNER_SCAN_BATCH) {
      const batch = await Promise.all(
        ids.slice(i, i + OWNER_SCAN_BATCH).map((id) => nft.ownerOf(id).catch(() => null))
      );
      for (const who of batch) {
        if (who == null) readAll = false;
        else holders.add(String(who).toLowerCase());
      }
    }
    owners = readAll ? holders.size : null;
  }

  const stats: CollectionStats = {
    ticker: col.ticker,
    address: col.address,
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : col.ticker,
    items: supply != null ? Number(supply) : minted,
    owners,
    freeMint: claimProbe,
  };
  statsCache.set(col.address, { at: now, stats });
  return stats;
}
