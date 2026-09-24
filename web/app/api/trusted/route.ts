import { NextResponse } from 'next/server';
import { addTrusted, removeTrusted } from '../../../lib/trusted';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { requirePassword } from '../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../lib/apiError';
import { notifyAllChannels } from '../../../lib/notifyChannels';
import { consumeTrustedAddTicket } from '../../../lib/trustedTicket';

/** Short form for a notification, where the full 0x is noise. */
function shortAddress(address: string): string {
  const a = String(address || '');
  return a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

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

    // The ticket is spent only now, after the add succeeded. Burning it earlier
    // would send somebody back to chat to start again over a failed write.
    const ticket = String(body.ticket || '').trim();
    if (ticket) {
      try {
        await consumeTrustedAddTicket(accountId, ticket);
      } catch (err) {
        console.warn('[trusted] ticket consume failed:', err);
      }
    }

    // Tell every linked chat, through the outbox the bots already drain.
    //
    // This is the half of the hold that makes it worth having: a destination
    // nobody is told about could sit out its 24 hours unnoticed. The message
    // has to name which destination and how to stop it, because the owner may
    // be reading it having done nothing at all.
    await notifyAllChannels(
      accountId,
      [
        'New payout destination added on the site.',
        `${row.label || '(no name)'}  ${shortAddress(row.address)}`,
        '',
        'It cannot receive anything for 24 hours.',
        `Not you? Reply: cancel wallet ${row.label || ''}`.trim(),
      ].join('\n')
    );

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
