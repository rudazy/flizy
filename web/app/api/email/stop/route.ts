/**
 * POST /api/email/stop
 * Body: { token }  the claim token from the "Stop these emails" link
 *
 * Stops claim notification emails to the address that claim was sent to
 * (web/lib/claimEmail.ts suppressClaimAddress). Only a hash of the address is
 * kept. The payment itself still works. A POST from the page's button, never a
 * GET, so a mail scanner opening the link stops nothing.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../lib/apiError';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { suppressClaimAddress } from '../../../../lib/claimEmail.ts';

const ROUTE = 'POST /api/email/stop';

export async function POST(req: Request) {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || '').trim().toLowerCase();
    const out = await suppressClaimAddress(getSupabase(), token);
    // The same answer either way: it says nothing about which links are real.
    return NextResponse.json({ ok: out === 'stopped' || out === 'not_found' });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
