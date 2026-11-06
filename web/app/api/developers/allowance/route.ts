/**
 * POST /api/developers/allowance: the platform account's passkey signs its
 * Flizy Pay API payout allowance, one per asset Flizy enabled, for that asset's
 * daily maximum, delegated to the API relayer, for 30 days.
 *
 *   { action: 'begin' }             fresh allowances; their digests to sign
 *   { action: 'finish', answers }   one passkey answer per allowance; each is
 *                                   checked by the account itself before it goes live
 *
 * The passkey's own user verification is the step-up, as for the account's
 * daily permissions (/api/custody/delegations): nothing goes live without it.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { platformForAccount } from '../../../../lib/apiPlatforms.ts';
import { beginAllowance, finishAllowance, type AllowanceAnswer } from '../../../../lib/apiAllowance.ts';
import { liveCeremonyDeps } from '../../../../lib/custody/liveDeps.ts';

const ROUTE = 'POST /api/developers/allowance';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const supabase = getSupabase();
    const platform = await platformForAccount(supabase, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const deps = liveCeremonyDeps(supabase);
    if (body?.action === 'begin') {
      return NextResponse.json(await beginAllowance(supabase, platform, deps), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (body?.action === 'finish') {
      const answers: AllowanceAnswer[] = (Array.isArray(body.answers) ? body.answers : []).slice(0, 3).map((a: Record<string, unknown>) => ({
        id: String(a?.id || ''),
        credentialId: String(a?.credentialId || ''),
        authenticatorData: String(a?.authenticatorData || ''),
        clientDataJSON: String(a?.clientDataJSON || ''),
        signature: String(a?.signature || ''),
      }));
      const origin = req.headers.get('origin') || '';
      return NextResponse.json(await finishAllowance(supabase, platform, answers, origin, deps));
    }
    return NextResponse.json({ error: 'Choose begin or finish.' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: err instanceof ClientError ? 400 : 500 });
  }
}
