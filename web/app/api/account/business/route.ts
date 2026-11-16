/**
 * Account > Business: read it, turn it on with the current business terms
 * (web/lib/businessTerms.ts), or turn it off.
 */

import { NextResponse } from 'next/server';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { BUSINESS_TERMS, BUSINESS_TERMS_VERSION, isCurrentBusinessTerms } from '../../../../lib/businessTerms.ts';

const SELECT = 'is_business, business_terms_version, business_since';

type BusinessRow = { is_business: boolean | null; business_terms_version: string | null; business_since: string | null };

/** A database that does not have the business columns yet. */
function notReady(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '');
  return code === '42703' || code === 'PGRST204' || (/is_business|business_terms_version|business_since/i.test(message) && /column|schema cache/i.test(message));
}

const NOT_READY = { error: 'Business accounts are not available yet.' };

function view(row: BusinessRow | null) {
  return {
    isBusiness: Boolean(row?.is_business),
    since: row?.is_business ? row.business_since : null,
    terms: { version: BUSINESS_TERMS_VERSION, lines: BUSINESS_TERMS },
  };
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { data, error } = await getSupabase().from('accounts').select(SELECT).eq('id', accountId).maybeSingle();
    if (notReady(error)) return NextResponse.json(NOT_READY, { status: 503 });
    if (error) return NextResponse.json(apiErrorBody('GET /api/account/business', error), { status: 500 });
    return NextResponse.json(view(data as BusinessRow | null));
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/account/business', err), { status: 500 });
  }
}

/** { on: true, termsVersion } turns it on with those terms; { on: false } turns it off. */
export async function POST(req: Request) {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    if (body.on !== true && body.on !== false) {
      return NextResponse.json({ error: 'Say whether to turn Business on or off.' }, { status: 400 });
    }
    if (body.on && !isCurrentBusinessTerms(body.termsVersion)) {
      // The terms changed while the page was open: show the current ones.
      return NextResponse.json({ error: 'The business terms have changed. Read them again, then turn Business on.', ...view(null) }, { status: 409 });
    }
    const patch = body.on
      ? { is_business: true, business_terms_version: BUSINESS_TERMS_VERSION, business_since: new Date().toISOString() }
      : { is_business: false };
    const { data, error } = await getSupabase().from('accounts').update(patch).eq('id', accountId).select(SELECT).maybeSingle();
    if (notReady(error)) return NextResponse.json(NOT_READY, { status: 503 });
    if (error) return NextResponse.json(apiErrorBody('POST /api/account/business', error), { status: 500 });
    return NextResponse.json(view(data as BusinessRow | null));
  } catch (err) {
    return NextResponse.json(apiErrorBody('POST /api/account/business', err), { status: 500 });
  }
}
