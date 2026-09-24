import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { readTrustedAddTicket } from '../../../../lib/trustedTicket';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'GET /api/trusted/ticket';

/**
 * Read an add begun in chat, so the site can prefill the address.
 *
 * Returns the address and label a ticket carries, nothing else. It does not
 * add, does not spend the ticket, and grants no authority: the add itself still
 * goes through POST /api/trusted behind requirePassword. A leaked code shows an
 * address to somebody who already holds the session, which is what they would
 * see on the page anyway.
 *
 * Signed in only, and the lookup is scoped to the caller's account, so a code
 * minted for one account cannot prefill another's form.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const code = new URL(req.url).searchParams.get('code') || '';
    const found = await readTrustedAddTicket(accountId, code);

    if (!found.ok) {
      // One message for all three reasons. Which of invalid, used or expired it
      // was tells a prober whether a code ever existed on this account.
      return NextResponse.json({
        ok: false,
        error: 'That link is not valid any more. Start again from chat.',
      });
    }

    return NextResponse.json({ ok: true, address: found.address, label: found.label });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
