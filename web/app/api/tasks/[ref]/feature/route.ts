import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { setTaskFeatured } from '../../../../../lib/tasks';

const ROUTE = 'POST|DELETE /api/tasks/[ref]/feature';

type Params = { params: { ref: string } };

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
export async function POST(req: Request, { params }: Params) {
  return set(req, params.ref, true);
}

/** Take the Featured mark off. */
export async function DELETE(req: Request, { params }: Params) {
  return set(req, params.ref, false);
}
