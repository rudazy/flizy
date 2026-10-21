import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { faucetStatus, normalizeFaucetAsset, FAUCET_UNKNOWN_ASSET, type FaucetAsset } from '../../../lib/faucet';

const ROUTE = 'GET /api/faucet';

/** Whether this account can claim an asset now (ETH, or ?asset=tusd), and when it can next. */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    let asset: FaucetAsset;
    try {
      asset = normalizeFaucetAsset(new URL(req.url).searchParams.get('asset'));
    } catch {
      return NextResponse.json({ error: FAUCET_UNKNOWN_ASSET }, { status: 400 });
    }
    return NextResponse.json(await faucetStatus(accountId, undefined, Date.now(), asset));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
