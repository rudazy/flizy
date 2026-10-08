import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { getProjectWorkspace, updateProject } from '../../../../../lib/tasks';

const GET_ROUTE = 'GET /api/projects/workspace/[handle]';
const PATCH_ROUTE = 'PATCH /api/projects/workspace/[handle]';

type Params = { params: { handle: string } };

/**
 * One project's workspace, for its owner or a member. Anyone else gets the
 * same 404 as a handle that does not exist.
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const workspace = await getProjectWorkspace(accountId, params.handle);
    if (!workspace) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }
    return NextResponse.json(workspace);
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
  }
}

/** Edit name, description, links, picture or banner. Fields left out are not changed. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const project = await updateProject(accountId, params.handle, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      links: Array.isArray(body.links) ? body.links : undefined,
      image: body.image === null || typeof body.image === 'string' ? body.image : undefined,
      banner: body.banner === null || typeof body.banner === 'string' ? body.banner : undefined,
    });
    return NextResponse.json({ ok: true, ...project });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(PATCH_ROUTE, err), { status: 400 });
  }
}
