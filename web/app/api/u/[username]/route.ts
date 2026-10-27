/**
 * Public profile. Viewable without a session and without a wallet.
 * Following is a separate request.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody, ClientError } from '../../../../lib/apiError';
import { clientIpKey } from '../../../../lib/clientIp.ts';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { allowFollowRead } from '../../../../lib/followRate.ts';
import { loadProfile } from '../../../../lib/followStore.ts';

const ROUTE = 'GET /api/u/[username]';

type Props = { params: { username: string } };

export async function GET(req: Request, { params }: Props) {
  try {
    const viewerId = await getAccountIdFromCookie();
    const key = viewerId || clientIpKey(req.headers);
    if (!allowFollowRead(key)) {
      return NextResponse.json({ error: 'Too many requests. Try again in a moment.' }, { status: 429 });
    }
    const profile = await loadProfile(params.username, viewerId);
    if (!profile) return NextResponse.json({ error: 'No profile with that username.' }, { status: 404 });
    return NextResponse.json(profile);
  } catch (err) {
    if (err instanceof ClientError) {
      // Deliberate: ClientError messages are author-written product copy.
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
