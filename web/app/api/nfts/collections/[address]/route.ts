import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../lib/apiError';
import {
  collectionHeader,
  marketStats,
  marketView,
  nftContext,
  royaltyInfo,
  routeAddress,
  usdRate,
} from '../../../../../lib/nftApi.ts';
import { FEE_BPS } from '../../../../../lib/nftMarket.ts';

const ROUTE = 'GET /api/nfts/collections/[address]';

/** Collection header and market figures: everything above the tabs. */
export async function GET(_req: Request, { params }: { params: { address: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const address = routeAddress(params.address);
    if (!address) return NextResponse.json({ error: 'Not a collection address' }, { status: 400 });

    const ctx = nftContext();
    const header = await collectionHeader(ctx, address);
    if (!header) return NextResponse.json({ error: 'No NFT collection at this address' }, { status: 404 });

    const [view, royalty, usdPerEth] = await Promise.all([
      marketView(ctx, address),
      royaltyInfo(ctx, address),
      usdRate(),
    ]);

    return NextResponse.json({
      collection: header,
      market: {
        enabled: view.enabled,
        address: view.address,
        paused: view.paused,
        // ERC-1155 shows here but only ERC-721 can be listed.
        tradable: view.enabled && header.standard === 'ERC-721',
        feeBps: FEE_BPS,
        royaltyBps: royalty?.bps ?? 0,
        royaltyReceiver: royalty?.receiver ?? null,
        stats: marketStats(view, address),
      },
      usdPerEth,
      explorerBaseUrl: ctx.chain.explorerBaseUrl,
      network: ctx.chain.name,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
