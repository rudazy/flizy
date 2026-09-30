import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { listedNfts } from '../../../lib/listedNfts';

const ROUTE = 'GET /api/nfts';

/**
 * Collections Flizy lists, including the ones this account does not hold.
 *
 * Holdings omit a zero balance. This page is the list a person compares a
 * contract against, so a collection they have not minted still has to be here.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    return NextResponse.json({
      collections: listedNfts().map((collection) => ({
        ticker: collection.ticker,
        address: collection.address,
      })),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
