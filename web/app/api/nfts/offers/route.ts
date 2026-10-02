import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { nftContext, usdRate, viewerWallet } from '../../../../lib/nftApi.ts';
import { offerBook } from '../../../../lib/offerBook.ts';

const ROUTE = 'GET /api/nfts/offers';

/**
 * The viewer's offer book: offers they made (expired ones included, so their
 * ETH can be taken back) and offers they can accept now. See web/lib/offerBook.ts.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const ctx = nftContext();
    if (!ctx.market) return NextResponse.json({ made: [], received: [], enabled: false, usdPerEth: null, network: ctx.chain.name });
    const viewer = await viewerWallet(accountId);
    const [book, usdPerEth] = await Promise.all([offerBook(ctx, accountId, viewer.address), usdRate()]);

    return NextResponse.json({ ...book, enabled: true, usdPerEth, network: ctx.chain.name, wallet: viewer.address });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
