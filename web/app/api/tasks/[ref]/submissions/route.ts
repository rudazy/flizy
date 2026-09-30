import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { listSubmissionsForCreator } from '../../../../../lib/tasks';

const ROUTE = 'GET /api/tasks/[ref]/submissions';

/**
 * The review list. Creator only, and only after the task has closed.
 *
 * Both of those are checked in listSubmissionsForCreator against the task's own
 * owner column, so a guessed ref returns the same "not found" as a ref that does
 * not exist. This is the one endpoint that exposes entries at all, which is why
 * it carries no public shape.
 */
export async function GET(_req: Request, ctx: { params: { ref: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const ref = Number(ctx.params.ref);
    if (!Number.isInteger(ref) || ref <= 0) {
      return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    }

    const result = await listSubmissionsForCreator(accountId, ref);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
