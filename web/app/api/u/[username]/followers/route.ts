/**
 * Who follows this profile. Public unless the account hid follower lists.
 * The owner can always open their own list.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody, ClientError } from '../../../../../lib/apiError';
import { clientIpKey } from '../../../../../lib/clientIp.ts';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { allowFollowRead } from '../../../../../lib/followRate.ts';
import { listPrefix } from '../../../../../lib/follows.ts';
import { listFollows } from '../../../../../lib/followStore.ts';

const ROUTE = 'GET /api/u/[username]/followers';

type Props = { params: { username: string } };

export async function GET(req: Request, { params }: Props) {
  try {
    const viewerId = await getAccountIdFromCookie();
    if (!allowFollowRead(viewerId || clientIpKey(req.headers))) {
      return NextResponse.json({ error: 'Too many requests. Try again in a moment.' }, { status: 429 });
    }
    const prefix = listPrefix(new URL(req.url).searchParams.get('q'));
    if (!prefix.ok) return NextResponse.json({ error: 'Use letters and numbers.' }, { status: 400 });
    const result = await listFollows(params.username, 'followers', prefix.prefix, viewerId);
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ people: result.people });
  } catch (err) {
    if (err instanceof ClientError) {
      // Deliberate: ClientError messages are author-written product copy.
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
