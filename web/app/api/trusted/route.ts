import { NextResponse } from 'next/server';
import { addTrusted, removeTrusted } from '../../../lib/trusted';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { requirePassword } from '../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../lib/apiError';

const ROUTE_POST = 'POST /api/trusted';
const ROUTE_DELETE = 'DELETE /api/trusted';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json();
    const supabase = getSupabase();
    const auth = await requirePassword(
      supabase,
      accountId,
      String(body.password || ''),
      'change trusted wallets'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const row = await addTrusted(accountId, String(body.address || ''), String(body.label || ''));
    return NextResponse.json({ trusted: row });
  } catch (err) {
    // "Invalid address" survives; a Supabase failure does not. Status stays 400
    // for both so the HTTP shape is unchanged.
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE_POST, err), { status: 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json();
    const supabase = getSupabase();
    const auth = await requirePassword(
      supabase,
      accountId,
      String(body.password || ''),
      'change trusted wallets'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    await removeTrusted(accountId, String(body.address || ''));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE_DELETE, err), { status: 400 });
  }
}
