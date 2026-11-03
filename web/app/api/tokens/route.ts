import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { snapshotFor, type TokenDay } from '../../../lib/tokenMarketServer';
import { cachedFlzDay, cachedListedDay } from '../../../lib/flzMarketCache';
import { cachedIndexedDays, type IndexedDays } from '../../../lib/pairWindowCache';
import { listTokens } from '../../../lib/tokenRows';
import { listWatched } from '../../../lib/tokenSocial';
import { LISTED_TOKENS } from '../../../lib/listedTokens';
import { anonymousReadLimit } from '../../../lib/readLimit';

const ROUTE = 'GET /api/tokens';

/**
 * Listed tokens for discovery: FLZ, then each token Flizy seeded a pool for,
 * every one priced from its own pool. A listed pool that cannot be read is
 * left out rather than failing the list. Open without a Flizy session for
 * wallet mode; the watchlist is an account feature and is empty then.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    const limited = await anonymousReadLimit(accountId);
    if (limited) return limited;

    const [day, watched, listedDays, indexed] = await Promise.all([
      cachedFlzDay(),
      accountId ? listWatched(accountId) : Promise.resolve([] as string[]),
      Promise.all(LISTED_TOKENS.map((token) => cachedListedDay(token.address).catch(() => null))),
      cachedIndexedDays().catch((): IndexedDays | null => null),
    ]);
    return NextResponse.json({
      tokens: listTokens({ flzDay: day, listedDays, indexed, watched, oneHour: (d: TokenDay) => snapshotFor(d, '1h') }),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
