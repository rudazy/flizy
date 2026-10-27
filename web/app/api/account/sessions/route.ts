/**
 * Where this account is signed in, and signing the other devices out.
 *
 * GET lists the live sessions. POST deletes every session except this browser.
 * The token hash is compared here and is not returned.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody, logApiError } from '../../../../lib/apiError';
import { isMissingSessionColumn, presentSessions, type StoredSession } from '../../../../lib/sessionClient';

export const dynamic = 'force-dynamic';

const GET_ROUTE = 'GET /api/account/sessions';
const POST_ROUTE = 'POST /api/account/sessions';

async function loadRows(accountId: string): Promise<StoredSession[]> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const full = await supabase
    .from('web_sessions')
    .select('id, token_hash, created_at, expires_at, client_label, client_place')
    .eq('account_id', accountId)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!full.error) return (full.data || []) as StoredSession[];
  if (!isMissingSessionColumn(full.error)) throw new Error(full.error.message);
  const plain = await supabase
    .from('web_sessions')
    .select('id, token_hash, created_at, expires_at')
    .eq('account_id', accountId)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(20);
  if (plain.error) throw new Error(plain.error.message);
  return (plain.data || []) as StoredSession[];
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const rows = await loadRows(accountId);
    return NextResponse.json({ sessions: presentSessions(rows, getSessionKey() || '') });
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    const hash = getSessionKey() || '';
    if (!accountId || !hash) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('web_sessions')
      .delete()
      .eq('account_id', accountId)
      .neq('token_hash', hash)
      .select('id');
    if (error) {
      logApiError(POST_ROUTE, error);
      return NextResponse.json({ error: 'Could not sign out the other devices.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, removed: (data || []).length });
  } catch (err) {
    return NextResponse.json(apiErrorBody(POST_ROUTE, err), { status: 500 });
  }
}
