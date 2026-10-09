import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../../../lib/apiError';
import { listedTokenKey, toggleLike } from '../../../../../../../lib/tokenSocial';

const ROUTE = 'POST /api/tokens/[symbol]/theses/[id]/like';

/** Like a thesis, or take the like back. */
export async function POST(req: Request, { params }: { params: { symbol: string; id: string } }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    return NextResponse.json(await toggleLike(accountId, key, params.id));
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
