/**
 * Find people by the start of a username, and a short list of suggested
 * profiles. No session and no wallet. Suggestions are people who already
 * have a follow, not a dump of every account.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody, ClientError } from '../../../lib/apiError';
import { clientIpKey } from '../../../lib/clientIp.ts';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { allowFollowRead } from '../../../lib/followRate.ts';
import { searchPrefix } from '../../../lib/follows.ts';
import { searchPeople, suggestPeople } from '../../../lib/followStore.ts';

const ROUTE = 'GET /api/people';

export async function GET(req: Request) {
  try {
    const viewerId = await getAccountIdFromCookie();
    if (!allowFollowRead(viewerId || clientIpKey(req.headers))) {
      return NextResponse.json({ error: 'Too many requests. Try again in a moment.' }, { status: 429 });
    }
    const raw = new URL(req.url).searchParams.get('q');
    const parsed = searchPrefix(raw);
    if (!parsed.ok) {
      if (!parsed.empty) return NextResponse.json({ error: 'Use at least two letters or numbers.' }, { status: 400 });
      const suggestions = await suggestPeople(viewerId);
      return NextResponse.json({ suggestions, results: [] });
    }
    const results = await searchPeople(parsed.prefix);
    return NextResponse.json({ suggestions: [], results });
  } catch (err) {
    if (err instanceof ClientError) {
      // Deliberate: ClientError messages are author-written product copy.
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
