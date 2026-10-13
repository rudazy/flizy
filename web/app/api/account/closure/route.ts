/**
 * Pause the signed-in account.
 *
 * Sets deactivated_at and ends every web session. The next successful
 * sign-in with the same email and the account password clears it. An older
 * deleted_at is cleared by that same sign-in. The account row, the wallet,
 * and the history stay. There is no delete.
 */

import { NextResponse } from 'next/server';
import { clearAccountCookie, getAccountIdFromCookie, revokeAllSessions } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { closureOf, isMissingClosureColumn } from '../../../../lib/accountClosure.ts';

const ROUTE = 'POST /api/account/closure';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action !== 'deactivate') {
      return NextResponse.json({ error: 'Choose deactivate.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: account, error: readError } = await supabase
      .from('accounts')
      .select('id, deleted_at, deactivated_at')
      .eq('id', accountId)
      .maybeSingle();

    if (readError && isMissingClosureColumn(readError)) {
      throw new ClientError('Account closure is not available yet.');
    }
    if (readError || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (closureOf(account) === 'deleted') {
      return NextResponse.json(
        { error: 'Sign in with this email to open the account.' },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const { data: paused, error: writeError } = await supabase
      .from('accounts')
      .update({ deactivated_at: now })
      .eq('id', accountId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (writeError) {
      if (isMissingClosureColumn(writeError)) {
        throw new ClientError('Account closure is not available yet.');
      }
      return NextResponse.json(apiErrorBody(ROUTE, writeError), { status: 500 });
    }
    if (!paused) {
      return NextResponse.json(
        { error: 'Sign in with this email to open the account.' },
        { status: 409 }
      );
    }

    try {
      await revokeAllSessions(accountId);
    } catch {
      // The pause flag is already set, so a leftover row stays refused.
      // Sign-in revokes those rows before it clears the flag.
      console.error('[closure] sessions were not all revoked');
    }
    await clearAccountCookie();
    return NextResponse.json({ ok: true, action: 'deactivated' });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 500 });
  }
}
