import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { faucetStatus } from '../../../lib/faucet';

const ROUTE = 'GET /api/faucet';

/** Whether this account can claim now, and when it can next. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    return NextResponse.json(await faucetStatus(accountId));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
