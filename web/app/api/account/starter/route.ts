/**
 * The signed-in account's starter pack progress: whether a chat is linked and
 * whether it has paid the starter host. Two booleans, nothing else.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { starterProgress } from '../../../../lib/starterPack.ts';

const ROUTE = 'GET /api/account/starter';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    return NextResponse.json(await starterProgress(accountId));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
