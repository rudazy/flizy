import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { cancelTask } from '../../../../../lib/tasks';

const ROUTE = 'POST /api/tasks/[ref]/cancel';

/**
 * Withdraw a task. Creator only.
 *
 * Entries are kept. They are the record that people did the work, and deleting
 * them because the creator changed their mind would erase the wrong side of that.
 */
export async function POST(req: Request, ctx: { params: { ref: string } }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const ref = Number(ctx.params.ref);
    if (!Number.isInteger(ref) || ref <= 0) {
      return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    }

    await cancelTask(accountId, ref);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
