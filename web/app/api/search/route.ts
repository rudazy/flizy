import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { siteSearch } from '../../../lib/siteSearch';

const ROUTE = 'GET /api/search';

/**
 * Searches per account per minute. Kept in this server instance's memory, so
 * it is a brake on a script, not an exact count across instances; each search
 * is a handful of bounded reads, which is what keeps the rest cheap.
 */
const PER_MINUTE = 60;
const recent = new Map<string, number[]>();

function overBudget(accountId: string, now: number): boolean {
  const kept = (recent.get(accountId) || []).filter((t) => now - t < 60_000);
  kept.push(now);
  recent.set(accountId, kept);
  if (recent.size > 5000) recent.clear();
  return kept.length > PER_MINUTE;
}

/** Live results for the search panel: tokens, projects, tasks, NFT collections, an exact @username. */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    if (overBudget(accountId, Date.now())) {
      return NextResponse.json({ error: 'Searching very fast. Try again in a moment.' }, { status: 429 });
    }
    const q = new URL(req.url).searchParams.get('q') || '';
    const groups = await siteSearch(q);
    return NextResponse.json({ q, groups });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
