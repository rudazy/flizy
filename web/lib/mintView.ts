/**
 * What the Mint pages and the mint route see: one drop's status, supply,
 * prices and, for the person asking, what they may mint right now.
 *
 * Flizy-managed drops are read from FlizyDrop. Contract-managed (external)
 * drops are read from the contract itself, and whether the viewer can mint is
 * the result of simulating the exact call from their wallet. Allowlist proofs
 * are built here, on the server, and never sent to the browser: the page only
 * learns "you are listed for 2".
 */

import { ethers } from 'ethers';
import {
  DROP_ABI,
  MAX_PER_TX,
  MINT_FEE_BPS,
  MINTABLE_ABI,
  decodeMintedLogs,
  headlinePriceWei,
  phaseView,
  readDrop,
  readSupply,
  type DropConfig,
  type DropStatus,
  type MintConfig,
  type MintedEvent,
} from './mintDrop.ts';
import { detectExternal, externalMintCall, simulateCall, takesQuantity, type ExternalMintFn } from './mintExternal.ts';
import { allowlistEntryFor, listAllowlist, type Db, type DropRow } from './mintDrops.ts';
import { allowlistProof } from './mintMerkle.ts';
import { verifiedCollection } from './listedNfts';
import { safeImageUrl, type NftIndex, type RawLog } from './nftIndex.ts';
import type { NftContext } from './nftApi.ts';

export type DropCard = {
  collection: string;
  mode: 'flizy' | 'external';
  name: string;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  verified: boolean;
  ticker: string | null;
  creatorUsername: string | null;
  status: DropStatus | 'live';
  /** Contract-managed: Flizy controls none of the rules. */
  contractManaged: boolean;
  minted: number;
  maxSupply: number | null;
  /** The price that applies now (or next), in wei; null when the contract does not say. */
  priceWei: string | null;
  config: DropConfig | null;
  allowlistLive: boolean;
  publicLive: boolean;
  nextChangeAt: number | null;
  /** Flizy-managed: the root on chain equals the saved list. */
  allowlistPublished: boolean | null;
  feeBps: number;
  externalFn: ExternalMintFn | null;
  /** ERC-2981 royalty in basis points, or null when the contract declares none. */
  royaltyBps: number | null;
};

const ROYALTY_ABI = ['function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)'];
const ONE_ETH = 10n ** 18n;

/** Royalty rate read back from a 1 ETH sale, as basis points. */
async function royaltyBpsOf(ctx: NftContext, collection: string): Promise<number | null> {
  try {
    const [, amount] = await new ethers.Contract(collection, ROYALTY_ABI, ctx.provider).royaltyInfo(1n, ONE_ETH);
    return Number((BigInt(amount) * 10_000n) / ONE_ETH);
  } catch {
    return null;
  }
}

const ZERO_ROOT = `0x${'0'.repeat(64)}`;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export async function dropCard(
  ctx: NftContext,
  cfg: MintConfig | null,
  row: DropRow,
  creatorUsername: string | null
): Promise<DropCard> {
  const verified = verifiedCollection(row.collection);
  const base = {
    collection: row.collection,
    mode: row.mode,
    name: row.name,
    description: row.description,
    imageUrl: safeImageUrl(row.image_url),
    bannerUrl: safeImageUrl(row.banner_url),
    verified: verified != null,
    ticker: verified?.ticker ?? null,
    creatorUsername,
    feeBps: row.mode === 'flizy' ? MINT_FEE_BPS : 0,
    externalFn: row.external_mint_fn,
    royaltyBps: await royaltyBpsOf(ctx, row.collection),
  };

  if (row.mode === 'external') {
    const d = await detectExternal(ctx.provider, row.collection);
    const soldOut = d.maxSupply != null && d.totalSupply != null && d.totalSupply >= d.maxSupply;
    const fnLive = row.external_mint_fn != null && d.mintFns.includes(row.external_mint_fn);
    return {
      ...base,
      status: soldOut ? 'sold_out' : fnLive ? 'live' : 'ended',
      contractManaged: true,
      minted: d.totalSupply ?? 0,
      maxSupply: d.maxSupply,
      priceWei: row.external_mint_fn === 'claim' ? '0' : d.priceWei,
      config: null,
      allowlistLive: false,
      publicLive: !soldOut && fnLive,
      nextChangeAt: null,
      allowlistPublished: null,
    };
  }

  if (!cfg) {
    return {
      ...base,
      status: 'unconfigured',
      contractManaged: false,
      minted: 0,
      maxSupply: null,
      priceWei: null,
      config: null,
      allowlistLive: false,
      publicLive: false,
      nextChangeAt: null,
      allowlistPublished: null,
    };
  }

  const [state, supply, chainImage] = await Promise.all([
    readDrop(ctx.provider, cfg, row.collection),
    readSupply(ctx.provider, row.collection),
    new ethers.Contract(row.collection, MINTABLE_ABI, ctx.provider)
      .image()
      .then((v: string) => safeImageUrl(v))
      .catch(() => null),
  ]);
  const view = phaseView(state, supply, nowSec());
  const c = state.config;
  const priceWei = c ? headlinePriceWei(c, view.allowlistLive, view.publicLive, nowSec()) : null;
  const savedRoot = row.allowlist_root || ZERO_ROOT;
  return {
    ...base,
    imageUrl: base.imageUrl ?? chainImage,
    status: view.status,
    contractManaged: false,
    minted: supply.minted,
    maxSupply: supply.max,
    priceWei,
    config: c,
    allowlistLive: view.allowlistLive,
    publicLive: view.publicLive,
    nextChangeAt: view.nextChangeAt,
    allowlistPublished: c ? c.merkleRoot === savedRoot.toLowerCase() : null,
  };
}

// ------------------------------------------------------------- eligibility

export type Eligibility = {
  wallet: string;
  allowlist: { listed: boolean; allowance: number; minted: number; remaining: number } | null;
  public: { minted: number; limit: number; remaining: number } | null;
  /** What a mint right now would be: the phase, the most this wallet may take, and the price each. */
  now: { phase: 'allowlist' | 'public' | 'external'; maxQuantity: number; priceWei: string | null } | null;
  /** Why `now` is null, in words for the page. */
  reason: string | null;
};

export async function eligibility(
  ctx: NftContext,
  cfg: MintConfig | null,
  row: DropRow,
  card: DropCard,
  wallet: string,
  supabase?: Db
): Promise<Eligibility> {
  const supplyLeft = card.maxSupply == null ? Infinity : Math.max(0, card.maxSupply - card.minted);

  if (row.mode === 'external') {
    if (card.status === 'sold_out') return { wallet, allowlist: null, public: null, now: null, reason: 'Sold out.' };
    if (!row.external_mint_fn || card.status !== 'live') {
      return { wallet, allowlist: null, public: null, now: null, reason: 'This contract has no supported public mint.' };
    }
    const fn = row.external_mint_fn;
    const call = externalMintCall(fn, 1, card.priceWei);
    const sim = await simulateCall(ctx.provider, wallet, row.collection, call);
    if (!sim.ok) return { wallet, allowlist: null, public: null, now: null, reason: sim.reason };
    const maxQuantity = takesQuantity(fn) ? Math.min(MAX_PER_TX, supplyLeft) : 1;
    return { wallet, allowlist: null, public: null, now: { phase: 'external', maxQuantity, priceWei: card.priceWei }, reason: null };
  }

  if (!cfg || !card.config) return { wallet, allowlist: null, public: null, now: null, reason: 'This mint is not set up yet.' };
  const c = card.config;
  const drop = new ethers.Contract(cfg.drop, DROP_ABI, ctx.provider);
  const [entry, alMinted, pubMinted] = await Promise.all([
    c.allowlistStart !== 0 ? allowlistEntryFor(row.id, wallet, supabase) : Promise.resolve(null),
    drop.allowlistMinted(row.collection, wallet).then(Number),
    drop.publicMinted(row.collection, wallet).then(Number),
  ]);
  const allowlist =
    c.allowlistStart === 0
      ? null
      : {
          listed: entry != null && card.allowlistPublished === true,
          allowance: entry?.allowance ?? 0,
          minted: alMinted,
          remaining: entry && card.allowlistPublished ? Math.max(0, entry.allowance - alMinted) : 0,
        };
  const pub = c.publicStart === 0 ? null : { minted: pubMinted, limit: c.publicLimit, remaining: Math.max(0, c.publicLimit - pubMinted) };

  let now: Eligibility['now'] = null;
  let reason: string | null = null;
  if (card.status === 'sold_out') reason = 'Sold out.';
  else if (card.status === 'ended') reason = 'This mint has ended.';
  else if (card.status === 'paused') reason = 'This mint is paused.';
  else if (card.status === 'upcoming') reason = 'This mint has not started yet.';
  else if (card.allowlistLive && allowlist && allowlist.remaining > 0) {
    now = { phase: 'allowlist', maxQuantity: Math.min(allowlist.remaining, MAX_PER_TX, supplyLeft), priceWei: c.allowlistPriceWei };
  } else if (card.publicLive && pub && pub.remaining > 0) {
    now = { phase: 'public', maxQuantity: Math.min(pub.remaining, MAX_PER_TX, supplyLeft), priceWei: c.publicPriceWei };
  } else if (card.publicLive && pub) reason = 'You have minted the most this wallet may in the public mint.';
  else if (card.allowlistLive && allowlist?.listed) reason = 'You have used your whole allowlist allowance.';
  else if (card.allowlistLive) reason = 'This wallet is not on the allowlist.';
  else reason = 'Nothing is minting right now.';
  if (now && now.maxQuantity < 1) {
    now = null;
    reason = 'Sold out.';
  }
  return { wallet, allowlist, public: pub, now, reason };
}

/** Server-only: the proof for this wallet's published allowlist entry. */
export async function proofFor(
  row: DropRow,
  wallet: string,
  supabase?: Db
): Promise<{ allowance: number; proof: string[] } | null> {
  const rows = await listAllowlist(row.id, supabase);
  const mine = rows.find((r) => r.address === ethers.getAddress(wallet));
  if (!mine) return null;
  const proof = allowlistProof(
    row.collection,
    rows.map((r) => ({ wallet: r.address, allowance: r.allowance })),
    { wallet: mine.address, allowance: mine.allowance }
  );
  return proof ? { allowance: mine.allowance, proof } : null;
}

// ------------------------------------------------------------------ caches

const CARD_TTL_MS = 20_000;
const CARD_MAX = 300;
const cardCache = new Map<string, { at: number; card: DropCard }>();

/** dropCard, cached briefly per collection: the Mint list reads many drops at once. */
export async function cachedDropCard(
  ctx: NftContext,
  cfg: MintConfig | null,
  row: DropRow,
  creatorUsername: string | null,
  now = Date.now()
): Promise<DropCard> {
  const key = `${row.collection}:${row.allowlist_root ?? ''}:${row.name}`;
  const hit = cardCache.get(key);
  if (hit && now - hit.at < CARD_TTL_MS) return { ...hit.card, creatorUsername };
  const card = await dropCard(ctx, cfg, row, creatorUsername);
  if (cardCache.size >= CARD_MAX) {
    const oldest = cardCache.keys().next().value;
    if (oldest !== undefined) cardCache.delete(oldest);
  }
  cardCache.set(key, { at: now, card });
  return card;
}

const EVENTS_TTL_MS = 15_000;
const MAX_LOG_PAGES = 40;
let eventsCache: { at: number; key: string; events: MintedEvent[] } | null = null;

/** Every Minted event since the FlizyDrop deploy block, through the explorer log API. Cached briefly. */
export async function loadMintedEvents(index: NftIndex, cfg: MintConfig, now = Date.now()): Promise<MintedEvent[]> {
  const key = `${cfg.drop}:${cfg.fromBlock}`;
  if (eventsCache && eventsCache.key === key && now - eventsCache.at < EVENTS_TTL_MS) return eventsCache.events;
  const logs: RawLog[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    const result = await index.logs(cfg.drop, cursor);
    logs.push(...result.items.filter((l) => l.blockNumber >= cfg.fromBlock));
    const oldest = result.items.length ? result.items[result.items.length - 1].blockNumber : 0;
    if (!result.next || oldest < cfg.fromBlock) break;
    cursor = result.next;
  }
  const events = decodeMintedLogs(logs);
  eventsCache = { at: now, key, events };
  return events;
}
