import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { setTaskSaved } from '../../../../../lib/tasks';
import { featureOn, pausedBody } from '../../../../../lib/features.ts';

const ROUTE = 'POST|DELETE /api/tasks/[ref]/save';

type Params = { params: Promise<{ ref: string }> };

async function set(req: Request, rawRef: string, on: boolean): Promise<Response> {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const ref = Number(rawRef);
    if (!Number.isInteger(ref) || ref <= 0) {
      return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    }

    return NextResponse.json({ saved: await setTaskSaved(accountId, ref, on) });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}

/** Save the task to My tasks. */
export async function POST(req: Request, { params: paramsIn }: Params) {
  // Paused feature (web/lib/features.ts): nothing new while it is off.
  if (!featureOn('tasks')) return NextResponse.json(pausedBody(), { status: 403 });
  const params = await paramsIn;
  return set(req, params.ref, true);
}

/** Remove the save. */
export async function DELETE(req: Request, { params: paramsIn }: Params) {
  const params = await paramsIn;
  return set(req, params.ref, false);
}
