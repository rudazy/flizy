import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { setTaskFeatured } from '../../../../../lib/tasks';
import { featureOn, pausedBody } from '../../../../../lib/features.ts';

const ROUTE = 'POST|DELETE /api/tasks/[ref]/feature';

type Params = { params: Promise<{ ref: string }> };

/** Flizy admins only. setTaskFeatured checks the flag before it writes. */
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

    return NextResponse.json({ featured: await setTaskFeatured(accountId, ref, on) });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}

/** Feature the task. */
export async function POST(req: Request, { params: paramsIn }: Params) {
  // Paused feature (web/lib/features.ts): nothing new while it is off.
  if (!featureOn('tasks')) return NextResponse.json(pausedBody(), { status: 403 });
  const params = await paramsIn;
  return set(req, params.ref, true);
}

/** Take the Featured mark off. */
export async function DELETE(req: Request, { params: paramsIn }: Params) {
  const params = await paramsIn;
  return set(req, params.ref, false);
}
