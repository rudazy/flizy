import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { nftContext } from '../../../../lib/nftApi.ts';
import { scanSetup } from '../../../../lib/scanSetup.ts';
import { syncWalletScan } from '../../../../lib/walletScanRecord.ts';

const ROUTE = 'POST /api/scan/sync';

// The explorer answers in a few seconds and each new row takes a few chain reads.
export const maxDuration = 60;

/** At most one sync per server instance in this window; calls in between share it or get 0. */
const SYNC_EVERY_MS = 30_000;
let lastSync = 0;
let syncing: Promise<number> | null = null;

/**
 * Bring guests' trades onto Scan (web/lib/walletScanRecord.ts). The Scan page
 * calls this beside its own read, so the feed never waits on the explorer, and
 * reads again when it says rows were written. Scan is for signed-in accounts,
 * so this is too; the instance window keeps page loads from multiplying the
 * explorer and chain reads.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    if (!(await getAccountIdFromCookie())) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    if (!syncing && Date.now() - lastSync >= SYNC_EVERY_MS) {
      lastSync = Date.now();
      const ctx = nftContext();
      syncing = syncWalletScan({
        provider: ctx.provider,
        supabase: getSupabase(),
        chainId: ctx.chain.chainId,
        setup: scanSetup(ctx),
        explorerUrl: ctx.chain.explorerBaseUrl,
      }).finally(() => {
        syncing = null;
      });
    }
    const written = syncing ? await syncing : 0;
    return NextResponse.json({ ok: true, written });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
