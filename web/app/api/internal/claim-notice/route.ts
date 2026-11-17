/**
 * Email a claim's recipient who is not on Flizy (web/lib/claimEmail.ts).
 *
 * Called by the bots, which hold no mail credentials. The bot names only the
 * claim and which email (first or reminder). The site reads the address from
 * the claim, applies every rule and limit, writes the email, and sends it. The
 * caller cannot choose the address, the wording or the link.
 *
 * Server to server: SECURITY_MAIL_SECRET as a bearer token, and unset refuses
 * every caller. The answer is the outcome only, never the address.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody } from '@/lib/apiError';
import { bearerMatches } from '@/lib/bearerSecret';
import { getSupabase } from '@/lib/supabase.ts';
import { sendClaimEmail } from '@/lib/claimEmail.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = 'POST /api/internal/claim-notice';
const NO_STORE = { 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get('authorization'), process.env.SECURITY_MAIL_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }
  const body = await req.json().catch(() => null);
  const claimId = typeof body?.claimId === 'string' ? body.claimId : '';
  const kind = body?.kind === 'reminder' ? 'reminder' : body?.kind === 'first' ? 'first' : null;
  if (!UUID.test(claimId) || !kind) return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE });
  try {
    const result = await sendClaimEmail({ db: getSupabase(), claimId, kind });
    return NextResponse.json({ ok: true, result }, { status: 200, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500, headers: NO_STORE });
  }
}
