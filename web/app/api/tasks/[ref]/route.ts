import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';
import { getTaskByRef } from '../../../../lib/tasks';

const ROUTE = 'GET /api/tasks/[ref]';

/**
 * One task. Public, because the page is meant to be shared.
 *
 * The session is read only to personalise: whether the viewer owns the task and
 * whether they have already entered. Entries themselves are never in the
 * response until the task is completed, and then only as the winner list.
 */
export async function GET(_req: Request, ctx: { params: { ref: string } }) {
  try {
    const ref = Number(ctx.params.ref);
    if (!Number.isInteger(ref) || ref <= 0) {
      return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    }

    // A signed-out visitor is the normal case here, so a missing cookie is not
    // an error.
    const viewerAccountId = await getAccountIdFromCookie().catch(() => null);
    const task = await getTaskByRef(ref, { viewerAccountId });
    if (!task) {
      return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    }
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
