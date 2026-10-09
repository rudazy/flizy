import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../lib/apiError';
import { loadFlzHolders } from '../../../../../lib/tokenHoldersServer';
import { listedTokenKey } from '../../../../../lib/tokenSocial';

const ROUTE = 'GET /api/tokens/[symbol]/holders';

// The same list for every viewer. Shared for 30 seconds so a caller looping
// this route cannot turn each request into explorer and RPC calls.
const cachedHolders = unstable_cache(() => loadFlzHolders(), ['flz-holders'], {
  revalidate: 30,
});

/**
 * Top holders of a listed token. Addresses come from the explorer, amounts
 * from the chain. FLZ is the only listed token, so it is the only one served.
 */
export async function GET(_req: Request, { params }: { params: { symbol: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    if (listedTokenKey(params.symbol) !== 'flz') {
      return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    }
    const holders = await cachedHolders();
    return NextResponse.json({ holders });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
