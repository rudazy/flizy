import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../lib/apiError';
import { loadFlzHolders } from '../../../../../lib/tokenHoldersServer';

const ROUTE = 'GET /api/tokens/flz/holders';

// The same list for every viewer. Shared for 30 seconds so a caller looping
// this route cannot turn each request into explorer and RPC calls.
const cachedHolders = unstable_cache(() => loadFlzHolders(), ['flz-holders'], {
  revalidate: 30,
});

/** Top FLZ holders. Addresses come from the explorer. Amounts come from the chain. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const holders = await cachedHolders();
    return NextResponse.json({ holders });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
