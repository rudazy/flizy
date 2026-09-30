import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { resolvePayRef } from '../../../../lib/payCode.ts';
import { addTrusted } from '../../../../lib/trusted';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { notifyAllChannels } from '../../../../lib/notifyChannels';
import { displaySafeLabel } from '../../../../lib/sanitize.ts';

/** Short form for a notification, where the full 0x is noise. */
function shortAddress(address: string): string {
  const a = String(address || '');
  return a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : a;
}

const ROUTE = 'POST /api/pay/save';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const payerId = await getAccountIdFromCookie();
    if (!payerId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();
    const auth = await requirePassword(
      supabase,
      payerId,
      String(body.password || ''),
      'save a trusted contact'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
    const merchant = await resolvePayRef(supabase, body.ref);
    if (!merchant?.accountId) {
      return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    }
    if (merchant.accountId === payerId) {
      return NextResponse.json({ error: 'You cannot save your own account.' }, { status: 400 });
    }
    const { data: dest } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', merchant.accountId)
      .maybeSingle();
    const to = dest?.agent_wallet_address;
    if (!to) {
      return NextResponse.json({ error: 'That account has no wallet yet.' }, { status: 400 });
    }
    // The label is another user's text and ends up in a notification body.
    // displaySafeLabel flattens control characters and newlines, and braces are
    // dropped so it can never carry a {{cmd:}} marker into the outbox.
    const label =
      displaySafeLabel(String(merchant.username || merchant.displayName || '').replace(/[{}]/g, '')) ||
      'merchant';
    const row = await addTrusted(payerId, to, label);

    // Every writer to the trusted list announces the new destination. One the
    // owner is never told about can sit out its 24 hours unnoticed, which is
    // most of the value of having a hold at all. Same outbox as everywhere else.
    await notifyAllChannels(
      payerId,
      [
        'New payout destination saved from a payment.',
        `${label}  ${shortAddress(to)}`,
        '',
        'It cannot receive anything for 24 hours.',
        `Not you? Reply: cancel wallet ${label}`,
      ].join('\n')
    );

    return NextResponse.json({ ok: true, trusted: row });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
