import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { nftContext } from '../../../../lib/nftApi.ts';
import { TX_HASH_RE } from '../../../../lib/externalPay.ts';
import { CALLER_LIMITED, takeCallerAttempt } from '../../../../lib/callerLimit.ts';
import { getDexAddresses } from '../../../../lib/dexServer.ts';
import { LISTED_TOKENS } from '../../../../lib/listedTokens.ts';
import { recordWalletTx, type ScanSetup } from '../../../../lib/walletScanRecord.ts';

const ROUTE = 'POST /api/scan/record';

/**
 * A connected wallet's transaction landed: put it on Scan.
 *
 * The body is only a transaction hash. What happened is read from the chain
 * (web/lib/walletScanRecord.ts), each hash is recorded once, and only while
 * it is recent. No session: wallet mode has none, so calls are capped per
 * caller per hour (web/lib/callerLimit.ts).
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const supabase = getSupabase();
    if (!(await takeCallerAttempt(supabase, req.headers, 'record'))) {
      return NextResponse.json(CALLER_LIMITED, { status: 429 });
    }
    const body = await req.json().catch(() => ({}));
    const txHash = String(body?.txHash || '');
    if (!TX_HASH_RE.test(txHash)) return NextResponse.json({ error: 'That is not a transaction hash.' }, { status: 400 });

    const ctx = nftContext();
    const dex = getDexAddresses();
    const setup: ScanSetup = {
      feeRouter: dex.feeRouter,
      weth: dex.wrappedNative,
      market: ctx.market?.address ?? null,
      tokens: [{ address: dex.flz, symbol: 'FLZ', decimals: 18 }, ...LISTED_TOKENS.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }))],
    };
    const recorded = await recordWalletTx({ provider: ctx.provider, supabase, txHash, chainId: ctx.chain.chainId, setup });
    return NextResponse.json({ ok: true, recorded });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
