import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../../lib/apiError';
import { marketView, nftContext, routeAddress } from '../../../../../../lib/nftApi.ts';
import { checkCursor } from '../../../../../../lib/nftIndex.ts';

const ROUTE = 'GET /api/nfts/collections/[address]/activity';
const MAX_MARKET_EVENTS = 100;

export type ActivityRow = {
  kind: 'sale' | 'list' | 'cancel' | 'offer' | 'mint' | 'transfer' | 'burn';
  tokenId: string | null;
  from: string | null;
  to: string | null;
  priceWei: string | null;
  txHash: string;
  timestamp: string | null;
};

/**
 * What happened in a collection: marketplace events (sales, listings, offers)
 * and on-chain transfers (mints, moves, burns), newest first. Transfers page
 * through the explorer; marketplace events come on the first page only, and
 * every page drops the transfer that a marketplace sale already explains.
 */
export async function GET(req: Request, { params }: { params: { address: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const address = routeAddress(params.address);
    if (!address) return NextResponse.json({ error: 'Not a collection address' }, { status: 400 });
    const rawCursor = new URL(req.url).searchParams.get('cursor');
    const cursor = rawCursor ? checkCursor(rawCursor) : null;
    if (rawCursor && !cursor) return NextResponse.json({ error: 'Bad cursor' }, { status: 400 });

    const ctx = nftContext();
    const [transfers, view] = await Promise.all([
      ctx.index.transfers(address, cursor),
      // Unscoped: Activity needs the event history, not which listings are buyable.
      marketView(ctx),
    ]);

    const market: ActivityRow[] = [];
    // A marketplace sale also shows up as an explorer transfer; drop the transfer.
    const saleTxs = new Set<string>();
    for (const e of view.state?.events ?? []) {
      if ('collection' in e && e.collection !== address) continue;
      if (e.kind === 'sold') saleTxs.add(e.txHash.toLowerCase());
      // Marketplace rows go on the first page; later pages only page transfers.
      if (cursor) continue;
      if (e.kind === 'sold') {
        market.push({ kind: 'sale', tokenId: e.tokenId, from: e.seller, to: e.buyer, priceWei: e.price, txHash: e.txHash, timestamp: e.timestamp });
      } else if (e.kind === 'listed') {
        market.push({ kind: 'list', tokenId: e.tokenId, from: e.seller, to: null, priceWei: e.price, txHash: e.txHash, timestamp: e.timestamp });
      } else if (e.kind === 'listingCancelled') {
        market.push({ kind: 'cancel', tokenId: e.tokenId, from: e.seller, to: null, priceWei: null, txHash: e.txHash, timestamp: e.timestamp });
      } else if (e.kind === 'offerMade') {
        market.push({ kind: 'offer', tokenId: e.anyToken ? null : e.tokenId, from: e.maker, to: null, priceWei: e.amount, txHash: e.txHash, timestamp: e.timestamp });
      }
    }
    const newest = (a: ActivityRow, b: ActivityRow) => Date.parse(b.timestamp || '0') - Date.parse(a.timestamp || '0');
    const rows: ActivityRow[] = market.sort(newest).slice(0, MAX_MARKET_EVENTS);
    for (const t of transfers.items) {
      if (saleTxs.has(t.txHash.toLowerCase())) continue;
      rows.push({ kind: t.kind, tokenId: t.tokenId, from: t.from, to: t.to, priceWei: null, txHash: t.txHash, timestamp: t.timestamp });
    }
    rows.sort(newest);

    return NextResponse.json({
      rows,
      next: transfers.next,
      explorerBaseUrl: ctx.chain.explorerBaseUrl,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
