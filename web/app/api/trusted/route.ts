import { NextResponse } from 'next/server';
import { addTrusted, removeTrusted } from '../../../lib/trusted';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { verifyPassword } from '../../../lib/cryptoPin';
import { apiErrorBodyAllowingClientError } from '../../../lib/apiError';

const ROUTE_POST = 'POST /api/trusted';
const ROUTE_DELETE = 'DELETE /api/trusted';

async function requirePassword(accountId: string, password: string) {
  if (!password) {
    return { ok: false as const, status: 400, error: 'Password is required to change trusted wallets' };
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('password_hash')
    .eq('id', accountId)
    .single();
  if (error || !data?.password_hash) {
    return { ok: false as const, status: 400, error: 'Could not verify account' };
  }
  if (!verifyPassword(password, data.password_hash)) {
    return { ok: false as const, status: 401, error: 'Incorrect password' };
  }
  return { ok: true as const };
}

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json();
    const password = String(body.password || '');
    const auth = await requirePassword(accountId, password);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
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
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json();
    const password = String(body.password || '');
    const auth = await requirePassword(accountId, password);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    await removeTrusted(accountId, String(body.address || ''));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE_DELETE, err), { status: 400 });
  }
}
