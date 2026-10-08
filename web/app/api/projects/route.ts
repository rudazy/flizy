import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError } from '../../../lib/apiError';
import { createProject, listOwnProjects, canCreateTasks } from '../../../lib/tasks';

const LIST_ROUTE = 'GET /api/projects';
const CREATE_ROUTE = 'POST /api/projects';

/** The projects this account can publish as. Used by the "create as" step. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    // `canCreate` is returned rather than inferred from the status code: this
    // route answers 200 to any signed-in account, so a 200 says nothing about
    // whether that account may create. A capability the caller needs is a field,
    // not a side effect of a status.
    const [projects, canCreate] = await Promise.all([
      listOwnProjects(accountId),
      canCreateTasks(accountId),
    ]);
    return NextResponse.json({ projects, canCreate });
  } catch (err) {
    return NextResponse.json(apiErrorBody(LIST_ROUTE, err), { status: 500 });
  }
}

/**
 * Create a publishing identity.
 *
 * Behind the same check as task creation: a project only exists to publish
 * tasks, so the two stay the same permission, and the account still has to
 * exist. Handles are a scarce namespace, so createProject caps how many one
 * account may hold.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    if (!(await canCreateTasks(accountId))) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const project = await createProject(accountId, {
      handle: String(body.handle || ''),
      name: String(body.name || ''),
      description: String(body.description || ''),
      links: Array.isArray(body.links) ? body.links : [],
      image: typeof body.image === 'string' ? body.image : null,
    });
    return NextResponse.json({ ok: true, ...project });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(CREATE_ROUTE, err), { status: 400 });
  }
}
