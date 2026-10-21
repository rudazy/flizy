import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { siteOrigin } from '../../../../lib/siteOrigin';
import {
  RECEIVED_WINDOWS,
  loadReceived,
  receivedCsv,
  refundLink,
  totalsByAsset,
  type ReceivedWindow,
} from '../../../../lib/merchant.ts';

const ROUTE = 'GET /api/payments/received';

/**
 * Payments into the signed-in account's wallet. ?days=30|90|365, and
 * ?format=csv for a file. Only ever the caller's own wallet.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const params = new URL(req.url).searchParams;
    const days = Number(params.get('days') || 30) as ReceivedWindow;
    if (!RECEIVED_WINDOWS.includes(days)) {
      return NextResponse.json({ error: `Pick ${RECEIVED_WINDOWS.join(', ')} days.` }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: me } = await supabase.from('accounts').select('agent_wallet_address').eq('id', accountId).maybeSingle();
    const wallet = String(me?.agent_wallet_address || '');
    const { payments, truncated } = await loadReceived(wallet, days, supabase);

    if (params.get('format') === 'csv') {
      return new NextResponse(receivedCsv(payments, truncated), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="flizy-received-${days}d.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const origin = siteOrigin();
    return NextResponse.json({
      days,
      truncated,
      totals: totalsByAsset(payments),
      payments: payments.map((p) => ({ ...p, refundUrl: refundLink(origin, p) })),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
