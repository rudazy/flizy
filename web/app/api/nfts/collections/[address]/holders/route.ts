import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../../../lib/apiError';
import { nftContext, routeAddress } from '../../../../../../lib/nftApi.ts';
import { checkCursor } from '../../../../../../lib/nftIndex.ts';
import { anonymousReadLimit } from '../../../../../../lib/readLimit';

const ROUTE = 'GET /api/nfts/collections/[address]/holders';

/** Holders with how many tokens each holds, largest first, paged. */
export async function GET(req: Request, { params }: { params: { address: string } }) {
  try {
    // Public chain data, open without a Flizy session for wallet mode, capped per caller.
    const limited = await anonymousReadLimit();
    if (limited) return limited;
    const address = routeAddress(params.address);
    if (!address) return NextResponse.json({ error: 'Not a collection address' }, { status: 400 });
    const rawCursor = new URL(req.url).searchParams.get('cursor');
    const cursor = rawCursor ? checkCursor(rawCursor) : null;
    if (rawCursor && !cursor) return NextResponse.json({ error: 'Bad cursor' }, { status: 400 });

    const ctx = nftContext();
    const [page, collection] = await Promise.all([ctx.index.holders(address, cursor), ctx.index.collection(address)]);
    return NextResponse.json({
      holders: page.items,
      next: page.next,
      total: collection?.holders ?? null,
      supply: collection?.supply ?? null,
      explorerBaseUrl: ctx.chain.explorerBaseUrl,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
