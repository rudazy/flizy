/**
 * POST /api/custody/delegations: the account's passkey signs Flizy's daily
 * spending permissions (0.1 ETH, 1000 FLZ, 50 tUSD a day, 30 days).
 *
 *   { action: 'begin' }             fresh permissions; their digests to sign
 *   { action: 'finish', answers }   one passkey answer per permission; each is
 *                                   checked by the account itself before it goes live
 *
 * Pilot accounts only. The passkey's own user verification is the step-up:
 * nothing goes live without it.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { beginDelegations, finishDelegations, inPilot, NOT_IN_PILOT, type SignedAnswer } from '../../../../lib/custody/ceremony.ts';
import { liveCeremonyDeps } from '../../../../lib/custody/liveDeps.ts';

const ROUTE = 'POST /api/custody/delegations';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    if (!inPilot(accountId)) return NextResponse.json({ error: NOT_IN_PILOT }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();
    const deps = liveCeremonyDeps(supabase);

    if (body?.action === 'begin') {
      return NextResponse.json(await beginDelegations(supabase, accountId, deps), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (body?.action === 'finish') {
      const answers: SignedAnswer[] = (Array.isArray(body.answers) ? body.answers : []).slice(0, 3).map((a: Record<string, unknown>) => ({
        id: String(a?.id || ''),
        credentialId: String(a?.credentialId || ''),
        authenticatorData: String(a?.authenticatorData || ''),
        clientDataJSON: String(a?.clientDataJSON || ''),
        signature: String(a?.signature || ''),
      }));
      const origin = req.headers.get('origin') || '';
      return NextResponse.json(await finishDelegations(supabase, accountId, answers, origin, deps));
    }
    return NextResponse.json({ error: 'Choose begin or finish.' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: err instanceof ClientError ? 400 : 500 });
  }
}
