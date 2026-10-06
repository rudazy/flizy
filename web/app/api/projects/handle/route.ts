/**
 * Is this project handle free? Read-only, for the create form.
 *
 * Signed in only. It calls the same check create uses, including the rule that
 * the signed-in account's own username is not a free project handle. The
 * username picker answers that case the other way and must not be reused here.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { projectHandleAvailable } from '../../../../lib/tasks';

const ROUTE = 'GET /api/projects/handle';

export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const raw = new URL(req.url).searchParams.get('h') || '';
    const check = await projectHandleAvailable(raw, accountId);
    return NextResponse.json(check);
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
