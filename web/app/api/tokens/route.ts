import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { loadFlzMarket } from '../../../lib/tokenMarketServer';

const ROUTE = 'GET /api/tokens';

/** Listed tokens for discovery. One market today, priced from its pool. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const market = await loadFlzMarket('1h');
    return NextResponse.json({
      tokens: [
        {
          symbol: market.symbol,
          name: market.name,
          priceEth: market.priceEth,
          change1hPct: market.change1hPct,
          liquidityEth: market.liquidityEth,
          verified: true,
        },
      ],
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
