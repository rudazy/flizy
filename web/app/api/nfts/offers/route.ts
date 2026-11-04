import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { guestViewer, nftContext, usdRate, viewerWallet } from '../../../../lib/nftApi.ts';
import { offerBook } from '../../../../lib/offerBook.ts';
import { anonymousReadLimit } from '../../../../lib/readLimit';

const ROUTE = 'GET /api/nfts/offers';

/**
 * The viewer's offer book: offers they made (expired ones included, so their
 * ETH can be taken back), offers they can accept now, and their past bids,
 * accepted or cancelled. See web/lib/offerBook.ts.
 *
 * A signed-out visitor in wallet mode names their wallet with ?viewer=. Offers
 * are public on the chain; nothing is saved, the read counts against the
 * anonymous cap, and no offer is hidden as declined, since declining is an
 * account action.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    const guest = accountId ? null : guestViewer(req);
    if (!accountId && !guest) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const limited = await anonymousReadLimit(accountId);
    if (limited) return limited;

    const ctx = nftContext();
    if (!ctx.market) return NextResponse.json({ made: [], received: [], past: [], enabled: false, usdPerEth: null, network: ctx.chain.name });
    const address = accountId ? (await viewerWallet(accountId)).address : (guest as string);
    const [book, usdPerEth] = await Promise.all([offerBook(ctx, accountId, address), usdRate()]);

    return NextResponse.json({ ...book, enabled: true, usdPerEth, network: ctx.chain.name, wallet: address });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
