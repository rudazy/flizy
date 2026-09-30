import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { submitToTask } from '../../../../../lib/tasks';

const ROUTE = 'POST /api/tasks/[ref]/submit';

/**
 * Enter a task.
 *
 * Every rule that matters is enforced below this route: the deadline by a
 * trigger, one entry per participant and one entry per post URL by unique
 * indexes. This layer validates shape and turns the database's answer into
 * something a person can read.
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

    const body = await req.json().catch(() => ({}));
    const result = await submitToTask(accountId, ref, {
      url: body.url ? String(body.url) : undefined,
      text: body.text ? String(body.text) : undefined,
    });

    return NextResponse.json({
      ok: true,
      submissionRef: result.submissionRef,
      verification: result.verification,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
