/**
 * Follow, unfollow, save activity alerts, or save the copy choice.
 *
 * The session is enough. No wallet, no payment, and no PIN. A second follow
 * of the same person does not add a row: the write ignores the duplicate and
 * the counts are read again afterwards.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody, ClientError } from '../../../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { allowFollowWrite } from '../../../../../lib/followRate.ts';
import { changeFollow } from '../../../../../lib/followStore.ts';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';

const ROUTE = 'POST|DELETE|PATCH /api/u/[username]/follow';

type Props = { params: { username: string } };

function answered(err: unknown) {
  if (err instanceof ClientError) {
    // Deliberate: ClientError messages are author-written product copy.
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
}

function saved(result: {
  following: boolean;
  alerts: boolean;
  copyTrade: boolean;
  followers: number;
  followingCount: number;
}) {
  return NextResponse.json({
    following: result.following,
    alerts: result.alerts,
    copyTrade: result.copyTrade,
    followers: result.followers,
    followingCount: result.followingCount,
  });
}

async function run(req: Request, username: string, action: 'follow' | 'unfollow') {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  const accountId = await getAccountIdFromCookie();
  if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
  if (!allowFollowWrite(accountId)) {
    return NextResponse.json({ error: 'Too many follows. Try again in a while.' }, { status: 429 });
  }
  const result = await changeFollow(accountId, username, action);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return saved(result);
}

export async function POST(req: Request, { params }: Props) {
  try {
    return await run(req, params.username, 'follow');
  } catch (err) {
    return answered(err);
  }
}

export async function DELETE(req: Request, { params }: Props) {
  try {
    return await run(req, params.username, 'unfollow');
  } catch (err) {
    return answered(err);
  }
}

export async function PATCH(req: Request, { params }: Props) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { alerts?: unknown; copyTrade?: unknown } | null;
    const alertsOn = typeof body?.alerts === 'boolean';
    const copyOn = typeof body?.copyTrade === 'boolean';
    // Exactly one choice. Checked before the write budget so a bad body does not spend it.
    if (alertsOn === copyOn) {
      return NextResponse.json({ error: 'Choose alerts or copy trade.' }, { status: 400 });
    }
    if (!allowFollowWrite(accountId)) {
      return NextResponse.json({ error: 'Too many follows. Try again in a while.' }, { status: 429 });
    }
    const result = await changeFollow(
      accountId,
      params.username,
      alertsOn ? 'alerts' : 'copy',
      alertsOn ? body?.alerts === true : body?.copyTrade === true
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return saved(result);
  } catch (err) {
    return answered(err);
  }
}
