import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../../lib/apiError';
import { addProjectMember, removeProjectMember } from '../../../../../../lib/tasks';

const ADD_ROUTE = 'POST /api/projects/workspace/[handle]/members';
const REMOVE_ROUTE = 'DELETE /api/projects/workspace/[handle]/members';

type Params = { params: { handle: string } };

async function change(
  req: Request,
  params: Params['params'],
  route: string,
  act: typeof addProjectMember
): Promise<Response> {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const members = await act(accountId, params.handle, String(body.username || ''));
    return NextResponse.json({ ok: true, members });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(route, err), { status: 400 });
  }
}

/** Add a member by @username. Owner only. */
export async function POST(req: Request, { params }: Params) {
  return change(req, params, ADD_ROUTE, addProjectMember);
}

/** Remove a member by @username: the owner removes anyone, a member only themselves. */
export async function DELETE(req: Request, { params }: Params) {
  return change(req, params, REMOVE_ROUTE, removeProjectMember);
}
