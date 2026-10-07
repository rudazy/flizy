/**
 * A wallet's offer book: the offers it has made, the offers it can accept, and
 * its past bids.
 *
 * Made: every open offer this wallet placed, expired ones included, because an
 * expired offer's ETH stays in the marketplace until its maker cancels it.
 *
 * Received: unexpired offers it could accept now. A single-NFT offer counts when
 * the wallet owns that NFT; a collection offer counts when the wallet holds at
 * least one NFT from that collection. The wallet's NFTs come from the explorer
 * first, so the market is never scanned token by token; then each offer and
 * each ownership is re-read from the chain. Offers the owner declined
 * (nft_offer_declines) are left out.
 *
 * Past: offers this wallet made that are closed, read from the marketplace
 * events already loaded. See closedBids in nftMarket.ts.
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase';
import { MARKET_ABI, closedBids, listingKey, type ClosedBid, type MarketEvent, type OpenOffer } from './nftMarket.ts';
import { marketView, type NftContext } from './nftApi.ts';
import { verifiedCollection } from './listedNfts';

export type BookOffer = {
  offerId: string;
  collection: string;
  collectionName: string;
  tokenId: string | null;
  amountWei: string;
  expiry: number;
  expired: boolean;
  maker: string;
  makerLabel: string | null;
  image: string | null;
  /** For a collection offer received: the viewer's NFTs it could be accepted with. */
  myTokenIds: string[];
  /** Royalty rate a sale at this amount pays now, rounded up; 0 for offers made. */
  royaltyBps: number;
};

export type PastBid = ClosedBid & { collectionName: string; image: string | null };

const MAX_OFFERS = 100;
const WALLET_PAGES = 3;
const NFT_ABI = ['function ownerOf(uint256) view returns (address)'];

/** closedBids with the collection's name and art, from the index and the Flizy registry. */
async function pastBids(ctx: NftContext, events: MarketEvent[], wallet: string): Promise<PastBid[]> {
  const closed = closedBids(events, wallet);
  const labels = new Map<string, { name: string; image: string | null }>();
  await Promise.all(
    [...new Set(closed.map((b) => b.collection))].slice(0, 25).map(async (address) => {
      const collection = await ctx.index.collection(address).catch(() => null);
      const verified = verifiedCollection(address);
      labels.set(address, {
        name: collection?.name ?? `${address.slice(0, 6)}...${address.slice(-4)}`,
        image: verified?.profile?.avatar ?? collection?.icon ?? null,
      });
    })
  );
  return closed.map((b) => ({
    ...b,
    collectionName: labels.get(b.collection)?.name ?? `${b.collection.slice(0, 6)}...${b.collection.slice(-4)}`,
    image: labels.get(b.collection)?.image ?? null,
  }));
}

/** Declined offer ids for this account on this marketplace. */
export async function declinedOfferIds(accountId: string, marketplace: string): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from('nft_offer_declines')
    .select('offer_id')
    .eq('account_id', accountId)
    .eq('marketplace', marketplace);
  if (error) throw error;
  return new Set((data || []).map((r) => String(r.offer_id)));
}

/** "@ada" for a maker who is on Flizy, else null and the page shows the address. */
async function makerLabels(makers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const supabase = getSupabase();
  await Promise.all(
    [...new Set(makers)].slice(0, 25).map(async (maker) => {
      const { data } = await supabase
        .from('accounts')
        .select('username')
        .ilike('agent_wallet_address', maker.toLowerCase())
        .maybeSingle();
      if (data?.username) out.set(maker, `@${data.username}`);
    })
  );
  return out;
}

export async function offerBook(
  ctx: NftContext,
  accountId: string,
  wallet: string
): Promise<{ made: BookOffer[]; received: BookOffer[]; past: PastBid[] }> {
  if (!ctx.market) return { made: [], received: [], past: [] };
  const market = new ethers.Contract(ctx.market.address, MARKET_ABI, ctx.provider);
  const view = await marketView(ctx);
  const all = [...(view.state?.offers.values() ?? [])];
  const nowSec = Math.floor(Date.now() / 1000);

  // What this wallet holds, by token and by collection.
  const heldTokens = new Map<string, { collection: string; tokenId: string }>();
  let cursor: string | null = null;
  for (let page = 0; page < WALLET_PAGES; page += 1) {
    const result = await ctx.index.walletNfts(wallet, cursor);
    for (const n of result.items) {
      if (n.standard === 'ERC-721') heldTokens.set(listingKey(n.collection, n.tokenId), { collection: n.collection, tokenId: n.tokenId });
    }
    if (!result.next) break;
    cursor = result.next;
  }
  const heldByCollection = new Map<string, string[]>();
  for (const t of heldTokens.values()) {
    heldByCollection.set(t.collection, [...(heldByCollection.get(t.collection) ?? []), t.tokenId]);
  }
  const declined = await declinedOfferIds(accountId, ctx.market.address);

  const newest = (a: OpenOffer, b: OpenOffer) => Date.parse(b.madeAt || '0') - Date.parse(a.madeAt || '0');
  const madeCandidates = all.filter((o) => o.maker === wallet).sort(newest).slice(0, MAX_OFFERS);
  const receivedCandidates = all
    .filter(
      (o) =>
        o.maker !== wallet &&
        o.expiry >= nowSec &&
        !declined.has(o.offerId) &&
        (o.tokenId ? heldTokens.has(listingKey(o.collection, o.tokenId)) : heldByCollection.has(o.collection))
    )
    .sort(newest)
    .slice(0, MAX_OFFERS);

  const labels = await makerLabels(receivedCandidates.map((o) => o.maker));

  const build = async (o: OpenOffer, side: 'made' | 'received'): Promise<BookOffer | null> => {
    const onChain = await market.getOffer(o.offerId).catch(() => null);
    if (!onChain || onChain.maker === ethers.ZeroAddress) return null;
    if (side === 'received' && o.tokenId) {
      const owner = await new ethers.Contract(o.collection, NFT_ABI, ctx.provider)
        .ownerOf(o.tokenId)
        .then((a: string) => ethers.getAddress(a))
        .catch(() => null);
      if (owner !== wallet) return null;
    }
    const collection = await ctx.index.collection(o.collection).catch(() => null);
    const verified = verifiedCollection(o.collection);
    const myTokenIds = side === 'received' && !o.tokenId ? (heldByCollection.get(o.collection) ?? []).slice(0, 20) : [];
    let royaltyBps = 0;
    if (side === 'received') {
      const amount = BigInt(onChain.amount);
      const probeToken = o.tokenId ?? myTokenIds[0] ?? '0';
      const [, due] = await market.royaltyFor(o.collection, probeToken, amount).catch(() => [null, 0n]);
      // Rounded up, so the seller's ceiling covers the contract's exact royalty.
      royaltyBps = amount > 0n ? Number((BigInt(due) * 10_000n + amount - 1n) / amount) : 0;
    }
    return {
      offerId: o.offerId,
      collection: o.collection,
      collectionName: collection?.name ?? `${o.collection.slice(0, 6)}...${o.collection.slice(-4)}`,
      tokenId: o.tokenId,
      amountWei: BigInt(onChain.amount).toString(),
      expiry: Number(onChain.expiry),
      expired: Number(onChain.expiry) < nowSec,
      maker: o.maker,
      makerLabel: labels.get(o.maker) ?? null,
      image: verified?.profile?.avatar ?? collection?.icon ?? null,
      myTokenIds,
      royaltyBps,
    };
  };

  const [made, received, closed] = await Promise.all([
    Promise.all(madeCandidates.map((o) => build(o, 'made'))),
    Promise.all(receivedCandidates.map((o) => build(o, 'received'))),
    pastBids(ctx, view.state?.events ?? [], wallet),
  ]);
  return {
    made: made.filter((o): o is BookOffer => o != null),
    received: received.filter((o): o is BookOffer => o != null),
    past: closed,
  };
}
