import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { countEnteredTasks } from '../../../../lib/tasks';

const ROUTE = 'GET /api/tasks/mine';

/**
 * How many tasks the signed-in account has entered, by state. Counts only,
 * for the Home summary; the account is the session's, never a parameter.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const counts = await countEnteredTasks(accountId);
    return NextResponse.json({ counts });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
