import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { listingFor, marketView, nftContext } from '../../../../lib/nftApi.ts';
import { listingKey } from '../../../../lib/nftMarket.ts';
import type { CollectionSummary } from '../../../../lib/nftIndex.ts';
import { verifiedCollection } from '../../../../lib/listedNfts';

const ROUTE = 'GET /api/nfts/liked';

/** The newest hearts that get names and art; the explorer is asked about each one. */
const MAX_LIKED = 60;
/** Explorer lookups in flight at once. */
const LOOKUPS_AT_ONCE = 6;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * The NFTs the viewer hearted, newest first, with each one's name and art from
 * the explorer and, when it is listed, its price. A listing counts only after
 * the on-chain check, the same as on the collection page.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const { data, error } = await getSupabase()
      .from('nft_favorites')
      .select('collection, token_id, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(MAX_LIKED);
    if (error) throw error;
    const rows = (data || []) as Array<{ collection: string; token_id: string; created_at: string | null }>;
    if (!rows.length) return NextResponse.json({ liked: [] });

    const ctx = nftContext();
    const keys = new Set(rows.map((r) => listingKey(r.collection, r.token_id)));
    const view = await marketView(ctx, (l) => keys.has(listingKey(l.collection, l.tokenId)));

    // One lookup per collection, however many of its NFTs are liked, started by
    // the first row that needs it so the lookups stay inside LOOKUPS_AT_ONCE.
    const collections = new Map<string, Promise<CollectionSummary | null>>();
    const collectionOf = (address: string) => {
      let pending = collections.get(address);
      if (!pending) {
        pending = ctx.index.collection(address).catch(() => null);
        collections.set(address, pending);
      }
      return pending;
    };

    const liked = await mapLimited(rows, LOOKUPS_AT_ONCE, async (row) => {
      const [item, collection] = await Promise.all([
        ctx.index.instance(row.collection, row.token_id).catch(() => null),
        collectionOf(row.collection),
      ]);
      const verified = verifiedCollection(row.collection);
      const collectionName = collection?.name ?? `${row.collection.slice(0, 6)}...${row.collection.slice(-4)}`;
      const { listing, valid } = listingFor(view, row.collection, row.token_id);
      return {
        collection: row.collection,
        collectionName,
        tokenId: row.token_id,
        name: item?.name || `${collectionName} #${row.token_id}`,
        image: item?.image || verified?.profile?.avatar || collection?.icon || null,
        verified: verified != null,
        listedWei: listing && valid ? listing.price : null,
        likedAt: row.created_at,
      };
    });

    return NextResponse.json({ liked });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
