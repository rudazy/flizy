import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError } from '../../../lib/apiError';
import { listTasks, createTask, canCreateTasks } from '../../../lib/tasks';

const LIST_ROUTE = 'GET /api/tasks';
const CREATE_ROUTE = 'POST /api/tasks';

/**
 * The discovery list. Public: a task page is meant to be shared, so the list
 * behind it cannot require a session.
 *
 * Counts only. Entries are never included here.
 */
export async function GET(req: Request) {
  try {
    const state = new URL(req.url).searchParams.get('state') === 'ended' ? 'ended' : 'live';
    const tasks = await listTasks({ state });
    return NextResponse.json({ tasks, state });
  } catch (err) {
    return NextResponse.json(apiErrorBody(LIST_ROUTE, err), { status: 500 });
  }
}

/**
 * Publish a task.
 *
 * Open to every signed-in account whose row exists. Task pages are public and
 * indexable, and nothing is escrowed yet, so createTask bounds what an open door
 * allows: live-task and per-day ceilings per account, and no title using the
 * Flizy name unless an admin publishes it.
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
      // A valid session whose account row is gone.
      return NextResponse.json({ error: 'Account not found.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const created = await createTask(accountId, {
      title: String(body.title || ''),
      description: String(body.description || ''),
      rewardKind: String(body.rewardKind || ''),
      rewardDisplay: String(body.rewardDisplay || ''),
      rewardAsset: body.rewardAsset ?? null,
      rewardTotal: body.rewardTotal ?? null,
      winnersCount: Number(body.winnersCount || 1),
      distribution: Array.isArray(body.distribution) ? body.distribution : [],
      endsAt: String(body.endsAt || ''),
      projectId: body.projectId ?? null,
      xpReward: body.xpReward ?? null,
      category: body.category ?? null,
      level: body.level ?? null,
      requirements: Array.isArray(body.requirements) ? body.requirements : [],
      links: Array.isArray(body.links) ? body.links : [],
    });

    return NextResponse.json({ ok: true, ref: created.ref });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(CREATE_ROUTE, err), { status: 400 });
  }
}
