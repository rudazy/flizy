/**
 * Is this @username free? Read-only, for the picker.
 *
 * Exists so somebody choosing a name learns it is taken while they are typing,
 * rather than after pressing Continue. Without it the only way to find out is
 * to submit and be refused, which is how a person ends up trying three names
 * and concluding the button is broken.
 *
 * Signed in only. Username existence is already public (a /pay/{username} page
 * resolves one for anyone), so this leaks nothing new, but requiring a session
 * keeps it from becoming a comfortable way to enumerate the whole table. The
 * people who need it are by definition logged in and choosing their own name.
 *
 * It answers the same question the save path answers and reuses the same two
 * checks, so the picker cannot say "available" about a name POST would refuse.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import {
  isUsernameReserved,
  normalizeUsername,
  USERNAME_UNAVAILABLE,
  validateUsername,
} from '../../../../../lib/username';
import { apiErrorBody } from '../../../../../lib/apiError';
import { isHandleTakenByProject } from '../../../../../lib/tasks';

const ROUTE = 'GET /api/account/username/check';

export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const raw = new URL(req.url).searchParams.get('u') || '';
    const check = validateUsername(raw);
    if (!check.ok) {
      // A format problem is not an availability answer. The picker already
      // shows these live from the shared validator; returning it keeps the two
      // from disagreeing.
      return NextResponse.json({ available: false, reason: check.error });
    }

    const supabase = getSupabase();

    // A project handle shares the namespace, and the set route refuses it, so
    // the picker must not call it available.
    if (
      (await isUsernameReserved(supabase, check.username)) ||
      (await isHandleTakenByProject(check.username, supabase))
    ) {
      return NextResponse.json({ available: false, reason: USERNAME_UNAVAILABLE });
    }

    const { data: holder, error } = await supabase
      .from('accounts')
      .select('id')
      .eq('username', check.username)
      .maybeSingle();

    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    // Their own current name is not a clash. Someone reopening the picker
    // should not be told the name they already hold is unavailable.
    if (holder && holder.id !== accountId) {
      return NextResponse.json({ available: false, reason: USERNAME_UNAVAILABLE });
    }

    return NextResponse.json({ available: true, username: normalizeUsername(check.username) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
