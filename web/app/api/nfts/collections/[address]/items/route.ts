import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../../lib/apiError';
import {
  listingFor,
  marketView,
  nftContext,
  routeAddress,
  toCard,
  viewerWallet,
  type NftCard,
} from '../../../../../../lib/nftApi.ts';
import { checkCursor, checkTokenId, type NftItem } from '../../../../../../lib/nftIndex.ts';
import { verifiedCollection } from '../../../../../../lib/listedNfts';

const ROUTE = 'GET /api/nfts/collections/[address]/items';
const FILTERS = ['all', 'listed', 'mine'] as const;
const SORTS = ['price_asc', 'price_desc', 'recent', 'id'] as const;
const MAX_LISTED = 100;

type Filter = (typeof FILTERS)[number];
type Sort = (typeof SORTS)[number];

function matches(card: NftCard, q: string): boolean {
  if (!q) return true;
  if (/^[0-9]+$/.test(q)) return card.tokenId === q;
  const needle = q.toLowerCase();
  return (
    card.name.toLowerCase().includes(needle) ||
    card.traits.some((t) => t.trait.toLowerCase().includes(needle) || t.value.toLowerCase().includes(needle))
  );
}

function byId(a: NftCard, b: NftCard) {
  const x = BigInt(a.tokenId);
  const y = BigInt(b.tokenId);
  return x < y ? -1 : x > y ? 1 : 0;
}

function sortCards(cards: NftCard[], sort: Sort): NftCard[] {
  const price = (c: NftCard) => (c.priceWei == null ? null : BigInt(c.priceWei));
  return [...cards].sort((a, b) => {
    if (sort === 'id') return byId(a, b);
    if (sort === 'recent') return Date.parse(b.listedAt || '0') - Date.parse(a.listedAt || '0') || byId(a, b);
    const pa = price(a);
    const pb = price(b);
    if (pa == null || pb == null) return pa == null && pb == null ? byId(a, b) : pa == null ? 1 : -1;
    if (pa === pb) return byId(a, b);
    return (sort === 'price_asc' ? pa < pb : pa > pb) ? -1 : 1;
  });
}

/**
 * Items in a collection. Listed tokens (checked on-chain) come first, sorted;
 * the rest page through the explorer. "mine" reads the viewer's wallet.
 */
export async function GET(req: Request, { params }: { params: { address: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const address = routeAddress(params.address);
    if (!address) return NextResponse.json({ error: 'Not a collection address' }, { status: 400 });

    const url = new URL(req.url);
    const filter = (FILTERS as readonly string[]).includes(url.searchParams.get('filter') || '')
      ? (url.searchParams.get('filter') as Filter)
      : 'all';
    const sort = (SORTS as readonly string[]).includes(url.searchParams.get('sort') || '')
      ? (url.searchParams.get('sort') as Sort)
      : 'price_asc';
    const q = (url.searchParams.get('q') || '').trim().replace(/^#/, '').slice(0, 64);
    const rawCursor = url.searchParams.get('cursor');
    const cursor = rawCursor ? checkCursor(rawCursor) : null;
    if (rawCursor && !cursor) return NextResponse.json({ error: 'Bad cursor' }, { status: 400 });

    const ctx = nftContext();
    const [collection, view, viewer] = await Promise.all([
      ctx.index.collection(address),
      marketView(ctx, address),
      viewerWallet(accountId),
    ]);
    if (!collection) return NextResponse.json({ error: 'No NFT collection at this address' }, { status: 404 });
    const fallback = verifiedCollection(address)?.profile?.avatar ?? null;
    const card = (item: NftItem) => {
      const { listing, valid } = listingFor(view, address, item.tokenId);
      return toCard(item, collection.name, listing, valid, fallback);
    };

    // Listed tokens, re-read from the explorer for their art and traits.
    let listed: NftCard[] = [];
    if (view.state && !cursor && filter !== 'mine') {
      const live = [...view.state.listings.values()]
        .filter((l) => l.collection === address && listingFor(view, address, l.tokenId).valid)
        .slice(0, MAX_LISTED);
      const items = await Promise.all(
        live.map((l) =>
          ctx.index
            .instance(address, l.tokenId)
            .catch(() => null)
            .then((item) => item || ({ collection: address, tokenId: l.tokenId, name: null, description: null, image: null, owner: l.seller, traits: [], externalUrl: null } as NftItem))
        )
      );
      listed = sortCards(items.map(card).filter((c) => matches(c, q)), sort);
    }

    let items: NftCard[] = [];
    let next: string | null = null;
    if (filter === 'mine') {
      const page = await ctx.index.walletNfts(viewer.address, cursor);
      items = page.items.filter((n) => n.collection === address).map(card).filter((c) => matches(c, q));
      next = page.next;
    } else if (filter === 'all') {
      const exact = checkTokenId(q);
      if (exact && !cursor) {
        const one = await ctx.index.instance(address, exact).catch(() => null);
        items = one && !listed.some((c) => c.tokenId === one.tokenId) ? [card(one)] : [];
      } else {
        const page = await ctx.index.instances(address, cursor);
        const shown = new Set(listed.map((c) => c.tokenId));
        items = page.items
          .map(card)
          .filter((c) => !shown.has(c.tokenId) && c.priceWei == null && matches(c, q));
        next = page.next;
      }
    }

    return NextResponse.json({
      listed,
      items: sort === 'id' ? sortCards(items, 'id') : items,
      next,
      viewer: viewer.address,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
