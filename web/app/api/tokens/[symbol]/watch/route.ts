import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { listedTokenKey, setWatched } from '../../../../../lib/tokenSocial';
import { featureOn, pausedBody } from '../../../../../lib/features.ts';

const ROUTE = 'POST|DELETE /api/tokens/[symbol]/watch';

type Params = { params: Promise<{ symbol: string }> };

async function set(req: Request, symbol: string, on: boolean): Promise<Response> {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    return NextResponse.json({ watched: await setWatched(accountId, key, on) });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}

/** Star the token. */
export async function POST(req: Request, { params: paramsIn }: Params) {
  // Paused feature (web/lib/features.ts): nothing new while it is off.
  if (!featureOn('tokenSocial')) return NextResponse.json(pausedBody(), { status: 403 });
  const params = await paramsIn;
  return set(req, params.symbol, true);
}

/** Unstar it. */
export async function DELETE(req: Request, { params: paramsIn }: Params) {
  const params = await paramsIn;
  return set(req, params.symbol, false);
}
