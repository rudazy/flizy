import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { nftContext, usdRate } from '../../../../lib/nftApi.ts';
import { mintConfig, mintStats, type MintStats } from '../../../../lib/mintDrop.ts';
import { creatorDrops, usernamesOf } from '../../../../lib/mintDrops.ts';
import { dropCard, loadMintedEvents } from '../../../../lib/mintView.ts';
import { clientErrorResponse } from '../../../../lib/mintRequest.ts';

const ROUTE = 'GET /api/mints/mine';

/**
 * My Mints: the drops this account launched on Flizy, each with its live
 * status and, for Flizy-managed drops, revenue to the creator, Flizy fees
 * and mints in the last 24 hours from the FlizyDrop Minted events.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const ctx = nftContext();
    const cfg = mintConfig();
    const rows = await creatorDrops(accountId);
    const names = await usernamesOf([accountId]);
    const events = cfg && rows.some((r) => r.mode === 'flizy') ? await loadMintedEvents(ctx.index, cfg).catch(() => []) : [];
    const now = Date.now();
    const drops = await Promise.all(
      rows.map(async (row) => {
        const card = await dropCard(ctx, cfg, row, names.get(accountId) ?? null);
        const stats: MintStats | null = row.mode === 'flizy' ? mintStats(events, row.collection, now) : null;
        return { ...card, stats };
      })
    );
    return NextResponse.json({ drops, usdPerEth: await usdRate(), live: cfg != null });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
