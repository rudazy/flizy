/**
 * Shared work behind the NFT routes: who is asking, what the explorer and the
 * marketplace say about a collection, and the card shape the pages render.
 *
 * Trust order: the chain decides ownership and buyability, the marketplace
 * events decide prices and history, the explorer lists and describes. The
 * Flizy registry alone decides "verified".
 */

import { ethers } from 'ethers';
import { getWebChain, deriveAgentWallet } from './dexServer';
import { pointerIsGator } from './gatorExecute.ts';
import { predictGatorAddress } from './gatorAccount.ts';
import { getSupabase } from './supabase';
import { nftIndex, type CollectionSummary, type NftIndex, type NftItem } from './nftIndex.ts';
import {
  MARKET_ABI,
  collectionMarket,
  listingKey,
  loadMarketState,
  marketConfig,
  validListingKeys,
  type MarketConfig,
  type MarketState,
  type OpenListing,
} from './nftMarket.ts';
import { verifiedCollection, type CollectionProfile } from './listedNfts';
import { ethUsd } from './ethUsd.ts';

export type NftContext = {
  chain: ReturnType<typeof getWebChain>;
  provider: ethers.JsonRpcProvider;
  index: NftIndex;
  market: MarketConfig | null;
};

export function nftContext(): NftContext {
  const chain = getWebChain();
  return {
    chain,
    provider: new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId),
    index: nftIndex(chain.explorerBaseUrl),
    market: marketConfig(),
  };
}

/** The wallet that holds this account's assets: the gator once the pointer moved, else the EOA. */
export async function viewerWallet(accountId: string): Promise<{ address: string; viaGator: boolean }> {
  const { data } = await getSupabase()
    .from('accounts')
    .select('agent_wallet_address')
    .eq('id', accountId)
    .maybeSingle();
  return walletForAccount(accountId, data?.agent_wallet_address);
}

/** viewerWallet for an account row already in hand (agent_wallet_address as stored). */
export function walletForAccount(
  accountId: string,
  storedPointer: string | null | undefined
): { address: string; viaGator: boolean } {
  const viaGator = pointerIsGator(accountId, storedPointer);
  return {
    address: viaGator ? predictGatorAddress(accountId) : deriveAgentWallet(accountId).address,
    viaGator,
  };
}

const PROBE_ABI = [
  'function MAX_SUPPLY() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function claimed(address) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function owner() view returns (address)',
];

export type CollectionHeader = CollectionSummary & {
  verified: boolean;
  ticker: string | null;
  profile: CollectionProfile | null;
  creator: string | null;
  createdAt: string | null;
  maxSupply: string | null;
  freeMint: boolean;
  contractOwner: string | null;
};

/** A 1 ETH sale, priced only to read the royalty rate back out as basis points. */
const ROYALTY_PROBE_PRICE = 10n ** 18n;

export async function collectionHeader(ctx: NftContext, address: string): Promise<CollectionHeader | null> {
  const summary = await ctx.index.collection(address);
  if (!summary) return null;
  const verified = verifiedCollection(address);
  const probe = new ethers.Contract(address, PROBE_ABI, ctx.provider);
  const [creation, maxSupply, totalSupply, freeMint, contractOwner] = await Promise.all([
    ctx.index.creation(address).catch(() => ({ creator: null, createdAt: null })),
    // Giwaforge names it MAX_SUPPLY; Flizy-native collections (FlizyCollection) maxSupply.
    probe
      .MAX_SUPPLY()
      .catch(() => probe.maxSupply())
      .then((v: bigint) => v.toString())
      .catch(() => null),
    probe.totalSupply().then((v: bigint) => v.toString()).catch(() => null),
    probe.claimed(ethers.ZeroAddress).then(() => true).catch(() => false),
    probe.owner().then((v: string) => ethers.getAddress(v)).catch(() => null),
  ]);
  return {
    ...summary,
    // The chain's supply wins over the explorer's when the contract exposes it.
    supply: totalSupply ?? summary.supply,
    verified: verified != null,
    ticker: verified?.ticker ?? null,
    profile: verified?.profile ?? null,
    creator: creation.creator,
    createdAt: creation.createdAt,
    maxSupply,
    freeMint,
    contractOwner,
  };
}

export type MarketView = {
  enabled: boolean;
  address: string | null;
  state: MarketState | null;
  valid: Set<string>;
  paused: boolean;
};

/** At most this many listings are checked on-chain per request, cheapest first. */
const MAX_VALIDATE = 300;

/**
 * Marketplace state with the listings in `scope` checked on-chain: one
 * collection's address, or a filter. Without a scope nothing is checked, so a
 * marketplace full of listings cannot turn one page view into thousands of
 * RPC calls. Only the cheapest MAX_VALIDATE in scope are checked; those are the
 * ones that set the floor.
 */
export async function marketView(ctx: NftContext, scope?: string | ((l: OpenListing) => boolean)): Promise<MarketView> {
  if (!ctx.market) return { enabled: false, address: null, state: null, valid: new Set(), paused: false };
  const state = await loadMarketState(ctx.index, ctx.market);
  const keep =
    typeof scope === 'string'
      ? (l: OpenListing) => l.collection.toLowerCase() === scope.toLowerCase()
      : scope ?? (() => false);
  const candidates = [...state.listings.values()]
    .filter(keep)
    .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0))
    .slice(0, MAX_VALIDATE);
  const contract = new ethers.Contract(ctx.market.address, MARKET_ABI, ctx.provider);
  const [valid, paused] = await Promise.all([
    validListingKeys(ctx.provider, ctx.market, candidates),
    contract.paused().then(Boolean).catch(() => false),
  ]);
  return { enabled: true, address: ctx.market.address, state, valid, paused };
}

export function marketStats(view: MarketView, collection: string) {
  if (!view.state) return null;
  return collectionMarket(view.state, collection, view.valid);
}

/** Royalty a sale would pay, as basis points, plus who receives it. Null when there is no market. */
export async function royaltyInfo(
  ctx: NftContext,
  collection: string
): Promise<{ bps: number; receiver: string | null } | null> {
  if (!ctx.market) return null;
  const market = new ethers.Contract(ctx.market.address, MARKET_ABI, ctx.provider);
  try {
    const [receiver, amount] = await market.royaltyFor(collection, 1, ROYALTY_PROBE_PRICE);
    // Rounded up: the seller's accepted ceiling must cover the contract's exact royalty.
    const bps = Number((BigInt(amount) * 10_000n + ROYALTY_PROBE_PRICE - 1n) / ROYALTY_PROBE_PRICE);
    return { bps, receiver: bps > 0 ? ethers.getAddress(receiver) : null };
  } catch {
    return null;
  }
}

export type NftCard = {
  collection: string;
  tokenId: string;
  name: string;
  image: string | null;
  owner: string | null;
  priceWei: string | null;
  seller: string | null;
  expiry: number | null;
  listedAt: string | null;
  traits: NftItem['traits'];
};

/** Card for one token. `fallbackImage` covers collections whose tokens carry no art. */
export function toCard(
  item: NftItem,
  collectionName: string,
  listing: OpenListing | undefined,
  validListing: boolean,
  fallbackImage: string | null
): NftCard {
  const live = listing && validListing ? listing : undefined;
  return {
    collection: item.collection,
    tokenId: item.tokenId,
    name: item.name || `${collectionName} #${item.tokenId}`,
    image: item.image || fallbackImage,
    owner: item.owner,
    priceWei: live?.price ?? null,
    seller: live?.seller ?? null,
    expiry: live?.expiry ?? null,
    listedAt: live?.listedAt ?? null,
    traits: item.traits,
  };
}

export function listingFor(view: MarketView, collection: string, tokenId: string) {
  const key = listingKey(collection, tokenId);
  const listing = view.state?.listings.get(key);
  return { listing, valid: listing ? view.valid.has(key) : false };
}

export async function usdRate(): Promise<number | null> {
  return ethUsd();
}

/** A collection address from a route segment, or null. */
export function routeAddress(raw: string | undefined): string | null {
  if (!raw || !ethers.isAddress(raw)) return null;
  return ethers.getAddress(raw);
}
