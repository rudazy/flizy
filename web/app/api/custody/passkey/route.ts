/**
 * POST /api/custody/passkey: add a passkey to the signed-in account's wallet.
 *
 *   { action: 'begin', password }   the account password, then a one-time
 *                                   challenge for navigator.credentials.create()
 *   { action: 'finish', ...answer } the browser's answer; the key is added to
 *                                   the account on chain (web/lib/custody/ceremony.ts)
 *
 * Pilot accounts only. Same-site, signed in, and the password is asked for
 * before a challenge exists, so a stolen session cannot add its own key.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { beginPasskey, finishPasskey, inPilot, NOT_IN_PILOT, type NewPasskey } from '../../../../lib/custody/ceremony.ts';
import { liveCeremonyDeps } from '../../../../lib/custody/liveDeps.ts';

const ROUTE = 'POST /api/custody/passkey';

export const maxDuration = 60;

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
      const password = String(body.password || '');
      if (password.length > 256) return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
      const pw = await requirePassword(supabase, accountId, password, 'add a passkey to your wallet');
      if (!pw.ok) return NextResponse.json({ error: pw.error, code: pw.code }, { status: pw.status });

      const { data: account } = await supabase.from('accounts').select('username').eq('id', accountId).maybeSingle();
      const options = await beginPasskey(supabase, accountId, account?.username ? `@${account.username}` : 'Flizy account', deps);
      return NextResponse.json(options, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (body?.action === 'finish') {
      const origin = req.headers.get('origin') || '';
      const answer: NewPasskey = {
        credentialId: String(body.credentialId || ''),
        clientDataJSON: String(body.clientDataJSON || ''),
        publicKey: String(body.publicKey || ''),
        publicKeyAlgorithm: Number(body.publicKeyAlgorithm),
      };
      const done = await finishPasskey(supabase, accountId, answer, origin, deps);
      return NextResponse.json({ ok: true, txHash: done.txHash });
    }

    return NextResponse.json({ error: 'Choose begin or finish.' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: err instanceof ClientError ? 400 : 500 });
  }
}
