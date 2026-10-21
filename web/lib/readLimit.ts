import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getAccountIdFromCookie } from './cookies';
import { getSupabase } from './supabase';
import { CALLER_LIMITED, takeCallerAttempt } from './callerLimit.ts';

/**
 * The read routes wallet mode opened: a signed-in caller passes as before, an
 * anonymous one counts against the hourly read cap (web/lib/callerLimit.ts).
 * Pass the account id when the route already has it. Returns the 429 to send,
 * or null to carry on.
 */
export async function anonymousReadLimit(accountId?: string | null): Promise<NextResponse | null> {
  const id = accountId === undefined ? await getAccountIdFromCookie() : accountId;
  if (id) return null;
  if (await takeCallerAttempt(getSupabase(), headers(), 'read')) return null;
  return NextResponse.json(CALLER_LIMITED, { status: 429 });
}
