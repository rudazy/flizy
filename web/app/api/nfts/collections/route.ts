import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { marketStats, marketView, nftContext } from '../../../../lib/nftApi.ts';
import { checkCursor, type CollectionSummary } from '../../../../lib/nftIndex.ts';
import { verifiedCollection } from '../../../../lib/listedNfts';

const ROUTE = 'GET /api/nfts/collections';

/**
 * Every NFT collection on the network, searchable, from the explorer. Verified
 * ones are marked. On the first page, collections with marketplace activity
 * come first so what is tradable now is not buried under large mints.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 64);
    const rawCursor = url.searchParams.get('cursor');
    const cursor = rawCursor ? checkCursor(rawCursor) : null;
    if (rawCursor && !cursor) return NextResponse.json({ error: 'Bad cursor' }, { status: 400 });

    const ctx = nftContext();
    // Unscoped first: the event history says which collections are active,
    // without checking any listing on-chain.
    const [page, history] = await Promise.all([ctx.index.searchCollections(q, cursor), marketView(ctx)]);

    let list: CollectionSummary[] = page.items;
    if (!cursor && !q && history.state) {
      const active = new Set(
        [...history.state.listings.values(), ...history.state.sales].map((x) => x.collection)
      );
      const missing = [...active].filter((a) => !list.some((c) => c.address === a));
      const extra = await Promise.all(missing.slice(0, 20).map((a) => ctx.index.collection(a).catch(() => null)));
      list = [...extra.filter((c): c is CollectionSummary => c != null), ...list];
      list.sort((a, b) => Number(active.has(b.address)) - Number(active.has(a.address)));
    }

    // Then only the listings of collections on this page, for their floors.
    const shown = new Set(list.map((c) => c.address));
    const view = await marketView(ctx, (l) => shown.has(l.collection));
    const collections = list.map((c) => {
      const verified = verifiedCollection(c.address);
      const stats = marketStats(view, c.address);
      return {
        ...c,
        verified: verified != null,
        avatar: verified?.profile?.avatar ?? c.icon,
        floorWei: stats?.floorWei ?? null,
        volumeWei: stats?.volumeWei ?? '0',
      };
    });

    return NextResponse.json({ collections, next: page.next });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
