import { NextResponse } from 'next/server';
import { createLinkCode } from '../../../../lib/identity';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/link/create';

export async function POST() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const link = await createLinkCode(accountId);
    return NextResponse.json(link);
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
