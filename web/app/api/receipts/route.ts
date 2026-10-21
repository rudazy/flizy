import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../lib/apiError';
import { shareReceipt } from '../../../lib/receipts.ts';
import { siteOrigin } from '../../../lib/siteOrigin';

const ROUTE = 'POST /api/receipts';

/**
 * Share one payment as a receipt link. Only the sender or the wallet that was
 * paid may; the body names the transfer and nothing else.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const token = await shareReceipt(accountId, String(body?.transferId ?? ''));
    return NextResponse.json({ ok: true, url: `${siteOrigin()}/r/${token}` });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
