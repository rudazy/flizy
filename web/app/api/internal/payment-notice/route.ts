/**
 * Record a payment that reached an account, and email that account.
 *
 * Called by the bots, which hold no mail credentials. The bot sends the
 * account id and the payment fields. The site writes the sentence, stores the
 * row, and mails the address on the account. The caller cannot choose the
 * email address, the wording, or the link.
 *
 * Server to server: there is no cookie and no browser, so the Origin check the
 * other mutating routes run does not apply. SECURITY_MAIL_SECRET unset refuses
 * every caller. The response says only whether it was handled.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody } from '@/lib/apiError';
import { bearerMatches } from '@/lib/bearerSecret';
import { saveIncomingPayment, type IncomingPayment } from '@/lib/incomingNotice';
import { getSupabase } from '@/lib/supabase.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = 'POST /api/internal/payment-notice';
const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get('authorization'), process.env.SECURITY_MAIL_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }

  const body = await req.json().catch(() => null);
  const input: IncomingPayment = {
    accountId: typeof body?.accountId === 'string' ? body.accountId : '',
    txHash: typeof body?.txHash === 'string' ? body.txHash : '',
    amount: typeof body?.amount === 'string' || typeof body?.amount === 'number' ? String(body.amount) : '',
    asset: typeof body?.asset === 'string' ? body.asset : '',
    fromLabel: typeof body?.fromLabel === 'string' ? body.fromLabel : '',
    note: typeof body?.note === 'string' ? body.note : null,
    tag: body?.tag === 'sale' ? 'sale' : 'payment',
    part: typeof body?.part === 'string' ? body.part : null,
  };

  try {
    const saved = await saveIncomingPayment(getSupabase(), input);
    if (saved === 'skipped') return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE });
    if (saved === 'unavailable') return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE });
    if (saved === 'unmailed') return NextResponse.json({ ok: false }, { status: 502, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500, headers: NO_STORE });
  }
}
