import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { snapshotFor, type TokenDay } from '../../../lib/tokenMarketServer';
import { cachedFlzDay, cachedListedDay } from '../../../lib/flzMarketCache';
import { listWatched } from '../../../lib/tokenSocial';
import { LISTED_TOKENS } from '../../../lib/listedTokens';

const ROUTE = 'GET /api/tokens';

/** Points in a row's sparkline. */
const SPARK_POINTS = 24;

/** The Explore row for one pool: its own figures, all in ETH. */
function row(day: TokenDay) {
  const market = snapshotFor(day, '1h');
  return {
    symbol: market.symbol,
    name: market.name,
    priceEth: market.priceEth,
    change1hPct: market.change1hPct,
    liquidityEth: market.liquidityEth,
    flzPerEth: market.flzPerEth,
    marketCapEth: market.marketCapEth,
    // Closing prices of the last hour's candles, for the sparkline.
    spark: market.candles.slice(-SPARK_POINTS).map((c) => c.close),
  };
}

/**
 * Listed tokens for discovery: FLZ, then each token Flizy seeded a pool for,
 * every one priced from its own pool. A listed pool that cannot be read is
 * left out rather than failing the list.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const [day, watched, listedDays] = await Promise.all([
      cachedFlzDay(),
      listWatched(accountId),
      Promise.all(LISTED_TOKENS.map((token) => cachedListedDay(token.address).catch(() => null))),
    ]);
    const listed = LISTED_TOKENS.flatMap((token, i) => {
      const listedDay = listedDays[i];
      if (!listedDay) return [];
      return [{ ...row(listedDay), symbol: token.symbol, name: token.name, address: token.address, verified: false }];
    });
    return NextResponse.json({
      tokens: [
        {
          ...row(day),
          verified: true,
          // Starred by this account, for the Watchlist filter.
          watched: watched.includes('flz'),
        },
        ...listed,
      ],
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
