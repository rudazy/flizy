/**
 * Where this account is signed in, and signing the other devices out.
 *
 * GET lists the live sessions. POST deletes every session except this browser.
 * DELETE with { id } signs out one other device; this browser's own session is
 * never matched, so it cannot sign itself out here (Log out does that).
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
const DELETE_ROUTE = 'DELETE /api/account/sessions';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadRows(accountId: string): Promise<StoredSession[]> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const full = await supabase
    .from('web_sessions')
    .select(
      'id, token_hash, created_at, expires_at, client_label, client_place, client_kind, client_model, client_network_place, last_seen_at'
    )
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
    return NextResponse.json({ sessions: presentSessions(rows, (await getSessionKey()) || '') });
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    const hash = (await getSessionKey()) || '';
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

export async function DELETE(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    const hash = (await getSessionKey()) || '';
    if (!accountId || !hash) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const id = String((body && body.id) || '').trim();
    if (!SESSION_ID.test(id)) return NextResponse.json({ error: 'Missing session id.' }, { status: 400 });

    // Scoped to this account and never this browser: an id from another
    // account, or this session's own id, matches nothing.
    const { data, error } = await getSupabase()
      .from('web_sessions')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .neq('token_hash', hash)
      .select('id');
    if (error) {
      logApiError(DELETE_ROUTE, error);
      return NextResponse.json({ error: 'Could not sign out that device.' }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'That device is already signed out.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(DELETE_ROUTE, err), { status: 500 });
  }
}
