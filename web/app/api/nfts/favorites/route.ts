import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { checkAddress, checkTokenId } from '../../../../lib/nftIndex.ts';

const ROUTE = 'GET|POST /api/nfts/favorites';

/** The viewer's hearts, optionally for one collection. */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const raw = new URL(req.url).searchParams.get('collection');
    const collection = raw ? checkAddress(raw) : null;
    if (raw && !collection) return NextResponse.json({ error: 'Not a collection address' }, { status: 400 });

    let query = getSupabase()
      .from('nft_favorites')
      .select('collection, token_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (collection) query = query.eq('collection', collection);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({
      favorites: (data || []).map((row) => ({ collection: row.collection, tokenId: row.token_id })),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}

/** Heart or un-heart one token: { collection, tokenId, on }. */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => null);
    const collection = checkAddress(body?.collection);
    const tokenId = checkTokenId(body?.tokenId);
    if (!collection || !tokenId || typeof body?.on !== 'boolean') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const table = getSupabase().from('nft_favorites');
    if (body.on) {
      const { error } = await table.upsert(
        { account_id: accountId, collection, token_id: tokenId },
        { onConflict: 'account_id,collection,token_id', ignoreDuplicates: true }
      );
      if (error) {
        if (/nft_favorites_cap/.test(error.message || '')) {
          return NextResponse.json({ error: 'You can keep up to 500 favorites.' }, { status: 409 });
        }
        throw error;
      }
    } else {
      const { error } = await table.delete().eq('account_id', accountId).eq('collection', collection).eq('token_id', tokenId);
      if (error) throw error;
    }
    return NextResponse.json({ ok: true, on: body.on });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
