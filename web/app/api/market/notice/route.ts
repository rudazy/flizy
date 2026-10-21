import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { nftContext } from '../../../../lib/nftApi.ts';
import { TX_HASH_RE } from '../../../../lib/externalPay.ts';
import { CALLER_LIMITED, takeCallerAttempt } from '../../../../lib/callerLimit.ts';
import { noticeWalletTrade } from '../../../../lib/walletMarket.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';

const ROUTE = 'POST /api/market/notice';

/**
 * A wallet-mode trade landed: tell the Flizy accounts it touched.
 *
 * The body is only a transaction hash. What happened is read from the
 * marketplace's own events in that transaction's receipt (web/lib/walletMarket.ts),
 * and each hash is announced once, only while it is recent. No session: the
 * trader has no Flizy account, so calls are capped per caller per hour
 * (web/lib/callerLimit.ts).
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const supabase = getSupabase();
    if (!(await takeCallerAttempt(supabase, req.headers, 'notice'))) {
      return NextResponse.json(CALLER_LIMITED, { status: 429 });
    }
    const body = await req.json().catch(() => ({}));
    const txHash = String(body?.txHash || '');
    if (!TX_HASH_RE.test(txHash)) return NextResponse.json({ error: 'That is not a transaction hash.' }, { status: 400 });

    const ctx = nftContext();
    if (!ctx.market) return NextResponse.json({ ok: true, announced: false });
    const announced = await noticeWalletTrade({
      provider: ctx.provider,
      txHash,
      marketAddress: ctx.market.address,
      siteUrl: siteOrigin(),
      supabase,
    });
    return NextResponse.json({ ok: true, announced });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
