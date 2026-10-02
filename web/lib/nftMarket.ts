/**
 * Marketplace state read from the FlizyMarketplace contract's own events.
 *
 * Events come through the explorer's log API (GIWA caps eth_getLogs ranges),
 * are decoded against the contract ABI, and folded oldest first into the open
 * listings, open offers and completed sales. A listing in that fold is only a
 * candidate: before it is shown as buyable it is re-checked on-chain with
 * isListingValid, which catches a seller who moved the token or revoked
 * approval without cancelling.
 */

import { ethers } from 'ethers';
import type { NftIndex, RawLog } from './nftIndex.ts';

export const MARKET_ABI = [
  'event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint256 price, uint64 expiry)',
  'event ListingCancelled(address indexed collection, uint256 indexed tokenId, address indexed seller)',
  'event Sold(address indexed collection, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price, uint256 fee, uint256 royalty, uint256 offerId)',
  'event OfferMade(uint256 indexed offerId, address indexed collection, address indexed maker, uint256 tokenId, bool anyToken, uint256 amount, uint64 expiry)',
  'event OfferCancelled(uint256 indexed offerId, address indexed maker)',
  'event RoyaltySet(address indexed collection, address indexed receiver, uint256 bps)',
  'function FEE_BPS() view returns (uint256)',
  'function MAX_ROYALTY_BPS() view returns (uint256)',
  'function paused() view returns (bool)',
  'function list(address collection, uint256 tokenId, uint256 price, uint64 expiry)',
  'function cancelListing(address collection, uint256 tokenId)',
  'function buy(address collection, uint256 tokenId, uint256 expectedPrice) payable',
  'function makeOffer(address collection, uint256 tokenId, bool anyToken, uint64 expiry) payable returns (uint256)',
  'function cancelOffer(uint256 offerId)',
  'function acceptOffer(uint256 offerId, uint256 tokenId, uint256 expectedAmount, uint256 maxRoyaltyBps)',
  'function setRoyalty(address collection, address receiver, uint256 bps)',
  'function withdraw()',
  'function credits(address) view returns (uint256)',
  'function getListing(address collection, uint256 tokenId) view returns (tuple(address seller, uint64 expiry, uint16 royaltyCapBps, uint256 price))',
  'function getOffer(uint256 offerId) view returns (tuple(address maker, uint64 expiry, bool anyToken, address collection, uint256 tokenId, uint256 amount))',
  'function isListingValid(address collection, uint256 tokenId) view returns (bool)',
  'function royaltyFor(address collection, uint256 tokenId, uint256 price) view returns (address receiver, uint256 amount)',
  'function royaltySetting(address collection) view returns (address receiver, uint256 bps, bool set)',
];

export const MARKET_IFACE = new ethers.Interface(MARKET_ABI);

/** Must match FlizyMarketplace.FEE_BPS. A test reads the contract source to keep them equal. */
export const FEE_BPS = 200;
export const MAX_ROYALTY_BPS = 1000;

export type MarketConfig = { address: string; fromBlock: number };

/** The deployed marketplace, or null when none is configured (trading off). */
export function marketConfig(env: Record<string, string | undefined> = process.env): MarketConfig | null {
  const raw = env.CHAIN_GIWA_SEPOLIA_MARKETPLACE;
  if (!raw || !ethers.isAddress(raw)) return null;
  const from = Number(env.CHAIN_GIWA_SEPOLIA_MARKETPLACE_FROM_BLOCK || 0);
  return { address: ethers.getAddress(raw), fromBlock: Number.isSafeInteger(from) && from > 0 ? from : 0 };
}

type Base = { blockNumber: number; logIndex: number; txHash: string; timestamp: string | null };

export type MarketEvent =
  | (Base & { kind: 'listed'; collection: string; tokenId: string; seller: string; price: string; expiry: number })
  | (Base & { kind: 'listingCancelled'; collection: string; tokenId: string; seller: string })
  | (Base & {
      kind: 'sold';
      collection: string;
      tokenId: string;
      buyer: string;
      seller: string;
      price: string;
      fee: string;
      royalty: string;
      offerId: string;
    })
  | (Base & {
      kind: 'offerMade';
      offerId: string;
      collection: string;
      maker: string;
      tokenId: string;
      anyToken: boolean;
      amount: string;
      expiry: number;
    })
  | (Base & { kind: 'offerCancelled'; offerId: string; maker: string })
  | (Base & { kind: 'royaltySet'; collection: string; receiver: string; bps: number });

/** Decodes marketplace logs, oldest first. Logs that are not marketplace events are skipped. */
export function decodeMarketLogs(logs: RawLog[]): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = MARKET_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const base: Base = {
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.txHash,
      timestamp: log.timestamp,
    };
    const a = parsed.args;
    const addr = (v: unknown) => ethers.getAddress(String(v));
    const num = (v: unknown) => BigInt(v as bigint).toString();
    switch (parsed.name) {
      case 'Listed':
        out.push({ ...base, kind: 'listed', collection: addr(a.collection), tokenId: num(a.tokenId), seller: addr(a.seller), price: num(a.price), expiry: Number(a.expiry) });
        break;
      case 'ListingCancelled':
        out.push({ ...base, kind: 'listingCancelled', collection: addr(a.collection), tokenId: num(a.tokenId), seller: addr(a.seller) });
        break;
      case 'Sold':
        out.push({
          ...base,
          kind: 'sold',
          collection: addr(a.collection),
          tokenId: num(a.tokenId),
          buyer: addr(a.buyer),
          seller: addr(a.seller),
          price: num(a.price),
          fee: num(a.fee),
          royalty: num(a.royalty),
          offerId: num(a.offerId),
        });
        break;
      case 'OfferMade':
        out.push({
          ...base,
          kind: 'offerMade',
          offerId: num(a.offerId),
          collection: addr(a.collection),
          maker: addr(a.maker),
          tokenId: num(a.tokenId),
          anyToken: Boolean(a.anyToken),
          amount: num(a.amount),
          expiry: Number(a.expiry),
        });
        break;
      case 'OfferCancelled':
        out.push({ ...base, kind: 'offerCancelled', offerId: num(a.offerId), maker: addr(a.maker) });
        break;
      case 'RoyaltySet':
        out.push({ ...base, kind: 'royaltySet', collection: addr(a.collection), receiver: addr(a.receiver), bps: Number(a.bps) });
        break;
      default:
        break;
    }
  }
  return out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
}

export type OpenListing = {
  collection: string;
  tokenId: string;
  seller: string;
  price: string;
  expiry: number;
  listedAt: string | null;
};

export type OpenOffer = {
  offerId: string;
  collection: string;
  maker: string;
  tokenId: string | null;
  amount: string;
  expiry: number;
  madeAt: string | null;
};

export type Sale = {
  collection: string;
  tokenId: string;
  buyer: string;
  seller: string;
  price: string;
  royalty: string;
  fee: string;
  viaOffer: boolean;
  txHash: string;
  timestamp: string | null;
  blockNumber: number;
};

export type MarketState = {
  listings: Map<string, OpenListing>;
  offers: Map<string, OpenOffer>;
  sales: Sale[];
  events: MarketEvent[];
};

export function listingKey(collection: string, tokenId: string): string {
  return `${collection.toLowerCase()}:${tokenId}`;
}

/** Replays events oldest first. The result is what the contract would hold, before validity checks. */
export function foldMarket(events: MarketEvent[]): MarketState {
  const listings = new Map<string, OpenListing>();
  const offers = new Map<string, OpenOffer>();
  const sales: Sale[] = [];
  for (const e of events) {
    if (e.kind === 'listed') {
      listings.set(listingKey(e.collection, e.tokenId), {
        collection: e.collection,
        tokenId: e.tokenId,
        seller: e.seller,
        price: e.price,
        expiry: e.expiry,
        listedAt: e.timestamp,
      });
    } else if (e.kind === 'listingCancelled') {
      listings.delete(listingKey(e.collection, e.tokenId));
    } else if (e.kind === 'sold') {
      listings.delete(listingKey(e.collection, e.tokenId));
      if (e.offerId !== '0') offers.delete(e.offerId);
      sales.push({
        collection: e.collection,
        tokenId: e.tokenId,
        buyer: e.buyer,
        seller: e.seller,
        price: e.price,
        royalty: e.royalty,
        fee: e.fee,
        viaOffer: e.offerId !== '0',
        txHash: e.txHash,
        timestamp: e.timestamp,
        blockNumber: e.blockNumber,
      });
    } else if (e.kind === 'offerMade') {
      offers.set(e.offerId, {
        offerId: e.offerId,
        collection: e.collection,
        maker: e.maker,
        tokenId: e.anyToken ? null : e.tokenId,
        amount: e.amount,
        expiry: e.expiry,
        madeAt: e.timestamp,
      });
    } else if (e.kind === 'offerCancelled') {
      offers.delete(e.offerId);
    }
  }
  return { listings, offers, sales, events };
}

export type CollectionMarket = {
  floorWei: string | null;
  volumeWei: string;
  salesCount: number;
  listedCount: number;
  bestOfferWei: string | null;
  /** Sale prices over time, oldest first, for the floor chart. */
  series: Array<{ t: string; priceWei: string }>;
};

/**
 * Figures for one collection. `valid` is the set of listing keys that passed
 * the on-chain check; only those count toward the floor and the listed count.
 */
export function collectionMarket(
  state: MarketState,
  collection: string,
  valid: Set<string>,
  nowSec = Math.floor(Date.now() / 1000)
): CollectionMarket {
  const col = collection.toLowerCase();
  let floor: bigint | null = null;
  let listedCount = 0;
  for (const [key, l] of state.listings) {
    if (l.collection.toLowerCase() !== col || !valid.has(key) || l.expiry < nowSec) continue;
    listedCount += 1;
    const price = BigInt(l.price);
    if (floor == null || price < floor) floor = price;
  }
  let volume = 0n;
  const series: Array<{ t: string; priceWei: string }> = [];
  let salesCount = 0;
  for (const s of state.sales) {
    if (s.collection.toLowerCase() !== col) continue;
    volume += BigInt(s.price);
    salesCount += 1;
    if (s.timestamp) series.push({ t: s.timestamp, priceWei: s.price });
  }
  let best: bigint | null = null;
  for (const o of state.offers.values()) {
    if (o.collection.toLowerCase() !== col || o.expiry < nowSec) continue;
    const amount = BigInt(o.amount);
    if (best == null || amount > best) best = amount;
  }
  return {
    floorWei: floor == null ? null : floor.toString(),
    volumeWei: volume.toString(),
    salesCount,
    listedCount,
    bestOfferWei: best == null ? null : best.toString(),
    series,
  };
}

// ---------------------------------------------------------------- loading

const STATE_TTL_MS = 15_000;
const MAX_LOG_PAGES = 40;
let stateCache: { at: number; key: string; state: MarketState } | null = null;

/** Every marketplace event since the deploy block, folded. Cached briefly. */
export async function loadMarketState(index: NftIndex, cfg: MarketConfig, now = Date.now()): Promise<MarketState> {
  const key = `${cfg.address}:${cfg.fromBlock}`;
  if (stateCache && stateCache.key === key && now - stateCache.at < STATE_TTL_MS) return stateCache.state;
  const logs: RawLog[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    const result = await index.logs(cfg.address, cursor);
    logs.push(...result.items.filter((l) => l.blockNumber >= cfg.fromBlock));
    const oldest = result.items.length ? result.items[result.items.length - 1].blockNumber : 0;
    if (!result.next || oldest < cfg.fromBlock) break;
    cursor = result.next;
  }
  const state = foldMarket(decodeMarketLogs(logs));
  stateCache = { at: now, key, state };
  return state;
}

const validCache = new Map<string, { at: number; ok: boolean }>();

/** Which candidate listings are buyable right now, asked of the contract. */
export async function validListingKeys(
  provider: ethers.Provider,
  cfg: MarketConfig,
  listings: OpenListing[],
  now = Date.now()
): Promise<Set<string>> {
  const market = new ethers.Contract(cfg.address, MARKET_ABI, provider);
  const out = new Set<string>();
  const pending: OpenListing[] = [];
  for (const l of listings) {
    const key = listingKey(l.collection, l.tokenId);
    const hit = validCache.get(`${key}:${l.price}`);
    if (hit && now - hit.at < STATE_TTL_MS) {
      if (hit.ok) out.add(key);
    } else {
      pending.push(l);
    }
  }
  for (let i = 0; i < pending.length; i += 25) {
    const batch = pending.slice(i, i + 25);
    const results = await Promise.all(
      batch.map((l) => market.isListingValid(l.collection, l.tokenId).then(Boolean).catch(() => false))
    );
    batch.forEach((l, j) => {
      const key = listingKey(l.collection, l.tokenId);
      validCache.set(`${key}:${l.price}`, { at: now, ok: results[j] });
      if (results[j]) out.add(key);
    });
  }
  if (validCache.size > 2000) validCache.clear();
  return out;
}

/** Price breakdown for a sale, mirroring FlizyMarketplace._settle. */
export function saleSplit(priceWei: bigint, royaltyWei: bigint) {
  const fee = (priceWei * BigInt(FEE_BPS)) / 10_000n;
  const cap = (priceWei * BigInt(MAX_ROYALTY_BPS)) / 10_000n;
  const royalty = royaltyWei > cap ? cap : royaltyWei;
  return { fee, royalty, seller: priceWei - fee - royalty };
}
