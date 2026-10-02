import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { listingFor, marketView, nftContext, viewerWallet } from '../../../../lib/nftApi.ts';
import { listingKey } from '../../../../lib/nftMarket.ts';
import { checkCursor } from '../../../../lib/nftIndex.ts';
import { verifiedCollection } from '../../../../lib/listedNfts';

const ROUTE = 'GET /api/nfts/mine';

/**
 * Every NFT in the viewer's wallet, any collection. Verified ones can be sent
 * in chat; the rest can be traded here but not sent on socials.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const rawCursor = new URL(req.url).searchParams.get('cursor');
    const cursor = rawCursor ? checkCursor(rawCursor) : null;
    if (rawCursor && !cursor) return NextResponse.json({ error: 'Bad cursor' }, { status: 400 });

    const ctx = nftContext();
    const viewer = await viewerWallet(accountId);
    const page = await ctx.index.walletNfts(viewer.address, cursor);
    // Only this wallet's own listings on this page are checked on-chain.
    const held = new Set(page.items.map((n) => listingKey(n.collection, n.tokenId)));
    const view = await marketView(ctx, (l) => l.seller === viewer.address && held.has(listingKey(l.collection, l.tokenId)));

    const nfts = page.items.map((n) => {
      const verified = verifiedCollection(n.collection);
      const { listing, valid } = listingFor(view, n.collection, n.tokenId);
      return {
        collection: n.collection,
        collectionName: n.collectionName,
        standard: n.standard,
        tokenId: n.tokenId,
        name: n.name || `${n.collectionName} #${n.tokenId}`,
        image: n.image || verified?.profile?.avatar || null,
        amount: n.amount,
        verified: verified != null,
        ticker: verified?.ticker ?? null,
        sendableInChat: verified != null && n.standard === 'ERC-721',
        listedWei: listing && valid && listing.seller === viewer.address ? listing.price : null,
      };
    });

    return NextResponse.json({ nfts, next: page.next, wallet: viewer.address });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
