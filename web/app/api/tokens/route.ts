import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { snapshotFor } from '../../../lib/tokenMarketServer';
import { cachedFlzDay } from '../../../lib/flzMarketCache';
import { listWatched } from '../../../lib/tokenSocial';

const ROUTE = 'GET /api/tokens';

/** Points in a row's sparkline. */
const SPARK_POINTS = 24;

/** Listed tokens for discovery. One market today, priced from its pool. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const [day, watched] = await Promise.all([cachedFlzDay(), listWatched(accountId)]);
    const market = snapshotFor(day, '1h');
    return NextResponse.json({
      tokens: [
        {
          symbol: market.symbol,
          name: market.name,
          priceEth: market.priceEth,
          change1hPct: market.change1hPct,
          liquidityEth: market.liquidityEth,
          verified: true,
          // Starred by this account, for the Watchlist filter.
          watched: watched.includes('flz'),
          // For the Explore row: the pool's own figures, all in ETH, and the
          // closing prices of the last hour's candles for its sparkline.
          flzPerEth: market.flzPerEth,
          marketCapEth: market.marketCapEth,
          spark: market.candles.slice(-SPARK_POINTS).map((c) => c.close),
        },
      ],
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
