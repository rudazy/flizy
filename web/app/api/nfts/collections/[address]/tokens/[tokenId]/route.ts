import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../../../lib/apiError';
import {
  collectionHeader,
  listingFor,
  marketView,
  nftContext,
  royaltyInfo,
  routeAddress,
  toCard,
  usdRate,
  viewerWallet,
} from '../../../../../../../lib/nftApi.ts';
import { checkTokenId, type NftItem } from '../../../../../../../lib/nftIndex.ts';
import { FEE_BPS, MARKET_ABI } from '../../../../../../../lib/nftMarket.ts';

const ROUTE = 'GET /api/nfts/collections/[address]/tokens/[tokenId]';
const NFT_ABI = [
  'function ownerOf(uint256) view returns (address)',
];

/**
 * One token: art, traits, owner (read from the chain), its listing if live,
 * open offers that can buy it, royalty, history, and what the viewer can do.
 */
export async function GET(_req: Request, { params }: { params: { address: string; tokenId: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const address = routeAddress(params.address);
    const tokenId = checkTokenId(params.tokenId);
    if (!address || !tokenId) return NextResponse.json({ error: 'Not a token' }, { status: 400 });

    const ctx = nftContext();
    const nft = new ethers.Contract(address, NFT_ABI, ctx.provider);
    const [header, instance, owner, view, royalty, viewer, usdPerEth, transfers] = await Promise.all([
      collectionHeader(ctx, address),
      ctx.index.instance(address, tokenId).catch(() => null),
      nft.ownerOf(tokenId).then((o: string) => ethers.getAddress(o)).catch(() => null),
      marketView(ctx, address),
      royaltyInfo(ctx, address),
      viewerWallet(accountId),
      usdRate(),
      ctx.index.tokenTransfers(address, tokenId).catch(() => ({ items: [], next: null })),
    ]);
    if (!header) return NextResponse.json({ error: 'No NFT collection at this address' }, { status: 404 });
    if (!owner) return NextResponse.json({ error: 'This token does not exist' }, { status: 404 });

    const item: NftItem = instance ?? {
      collection: address,
      tokenId,
      name: null,
      description: null,
      image: null,
      owner,
      traits: [],
      externalUrl: null,
    };
    const { listing, valid } = listingFor(view, address, tokenId);
    const card = { ...toCard(item, header.name, listing, valid, header.profile?.avatar ?? null), owner };

    const nowSec = Math.floor(Date.now() / 1000);
    const offers = [...(view.state?.offers.values() ?? [])]
      .filter((o) => o.collection === address && o.expiry >= nowSec && (o.tokenId == null || o.tokenId === tokenId))
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0))
      .slice(0, 50);

    const history = (view.state?.events ?? [])
      .filter((e) => 'tokenId' in e && 'collection' in e && e.collection === address && e.tokenId === tokenId)
      .map((e) => ({ kind: e.kind, txHash: e.txHash, timestamp: e.timestamp, ...('price' in e ? { priceWei: e.price } : {}) }));

    let credits = '0';
    let myOffers: string[] = [];
    if (view.address) {
      const market = new ethers.Contract(view.address, MARKET_ABI, ctx.provider);
      credits = await market.credits(viewer.address).then((v: bigint) => v.toString()).catch(() => '0');
      myOffers = offers.filter((o) => o.maker === viewer.address).map((o) => o.offerId);
    }

    return NextResponse.json({
      collection: header,
      // A metadata link is the creator's to choose. Only verified collections get
      // one on the page, so an unverified collection cannot place a lure there.
      token: { ...card, description: item.description, externalUrl: header.verified ? item.externalUrl : null },
      offers,
      transfers: transfers.items,
      history,
      market: {
        enabled: view.enabled,
        address: view.address,
        paused: view.paused,
        tradable: view.enabled && header.standard === 'ERC-721',
        feeBps: FEE_BPS,
        royaltyBps: royalty?.bps ?? 0,
        royaltyReceiver: royalty?.receiver ?? null,
      },
      viewer: {
        address: viewer.address,
        isOwner: owner === viewer.address,
        isSeller: card.seller === viewer.address,
        credits,
        myOffers,
      },
      usdPerEth,
      explorerBaseUrl: ctx.chain.explorerBaseUrl,
      network: ctx.chain.name,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
