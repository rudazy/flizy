import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { nftContext, usdRate, viewerWallet } from '../../../../lib/nftApi.ts';
import { mintConfig } from '../../../../lib/mintDrop.ts';
import { getDrop, usernamesOf } from '../../../../lib/mintDrops.ts';
import { dropCard, eligibility } from '../../../../lib/mintView.ts';
import { clientErrorResponse, routeCollection } from '../../../../lib/mintRequest.ts';

const ROUTE = 'GET /api/mints/[collection]';

/**
 * One drop for the Mint panel: status, schedule, supply, prices, the 2% fee
 * on Flizy-managed mints, and what the person asking may mint right now.
 * 404 with { drop: null } when the collection does not mint through Flizy, so
 * the collection page can simply show no Mint tab.
 */
export async function GET(_req: Request, { params }: { params: { collection: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const collection = routeCollection(params.collection);
    const row = await getDrop(collection);
    if (!row) return NextResponse.json({ drop: null }, { status: 404 });

    const ctx = nftContext();
    const cfg = mintConfig();
    const [names, viewer] = await Promise.all([
      usernamesOf(row.creator_account_id ? [row.creator_account_id] : []),
      viewerWallet(accountId),
    ]);
    const card = await dropCard(ctx, cfg, row, row.creator_account_id ? names.get(row.creator_account_id) ?? null : null);
    const viewerElig = await eligibility(ctx, cfg, row, card, viewer.address);
    return NextResponse.json({
      drop: card,
      viewer: viewerElig,
      isCreator: row.creator_account_id === accountId,
      usdPerEth: await usdRate(),
    });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
