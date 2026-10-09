import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { ClientError, apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { isChartRange } from '../../../../lib/tokenMarket';
import { snapshotFor } from '../../../../lib/tokenMarketServer';
import { cachedFlzDay } from '../../../../lib/flzMarketCache';
import { ethUsd } from '../../../../lib/ethUsd';
import { describeHeldToken } from '../../../../lib/accountTokens';

const ROUTE = 'GET /api/tokens/[symbol]';


/** FLZ is the verified market. A contract address is a wallet token, traded without a listing. */
export async function GET(req: Request, { params }: { params: { symbol: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const raw = String(params.symbol || '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      const described = await describeHeldToken(accountId, raw);
      if ('listedSymbol' in described) {
        return NextResponse.json({ listedSymbol: described.listedSymbol });
      }
      if ('missing' in described) {
        return NextResponse.json({ error: described.missing }, { status: 404 });
      }
      return NextResponse.json({ held: described.held });
    }

    const symbol = raw.toLowerCase();
    if (symbol !== 'flz') {
      return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    }

    const requested = new URL(req.url).searchParams.get('range') || '1h';
    const range = isChartRange(requested) ? requested : '1h';
    const [day, usdPerEth] = await Promise.all([cachedFlzDay(), ethUsd()]);
    // usdPerEth is for the ≈ dollar figures only; null when the price source is down.
    return NextResponse.json({ market: snapshotFor(day, range), usdPerEth });
  } catch (err) {
    const status = err instanceof ClientError ? 400 : 500;
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status });
  }
}
