import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { nftContext, usdRate } from '../../../lib/nftApi.ts';
import { mintConfig } from '../../../lib/mintDrop.ts';
import { listDrops, usernamesOf } from '../../../lib/mintDrops.ts';
import { cachedDropCard, type DropCard } from '../../../lib/mintView.ts';
import { clientErrorResponse } from '../../../lib/mintRequest.ts';

const ROUTE = 'GET /api/mints';
const FILTERS = ['live', 'upcoming', 'allowlist', 'ending', 'all'] as const;
type Filter = (typeof FILTERS)[number];
const DAY_SEC = 24 * 60 * 60;

function isLive(c: DropCard): boolean {
  return c.status === 'public' || c.status === 'allowlist' || c.status === 'live';
}

function matches(c: DropCard, filter: Filter, now: number): boolean {
  switch (filter) {
    case 'live':
      return isLive(c);
    case 'upcoming':
      return c.status === 'upcoming';
    case 'allowlist':
      // Allowlist phase running, or coming up next.
      return (
        c.allowlistLive ||
        (c.status === 'upcoming' && c.config != null && c.config.allowlistStart !== 0 && c.config.allowlistStart > now)
      );
    case 'ending':
      return isLive(c) && c.config != null && c.config.mintEnd !== 0 && c.config.mintEnd - now <= DAY_SEC;
    default:
      return true;
  }
}

const ORDER: Record<string, number> = { public: 0, allowlist: 0, live: 0, upcoming: 1, paused: 2, unconfigured: 3, sold_out: 4, ended: 5 };

/**
 * Drops that mint through Flizy, Flizy-managed and Contract-managed, with each
 * one's status read from the chain. ?status=live|upcoming|allowlist|ending|all.
 * Unconfigured Flizy-managed drops are left out of the public list until their
 * creator sets a schedule.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const raw = new URL(req.url).searchParams.get('status') || 'live';
    const filter: Filter = (FILTERS as readonly string[]).includes(raw) ? (raw as Filter) : 'live';

    const ctx = nftContext();
    const cfg = mintConfig();
    const rows = await listDrops();
    const names = await usernamesOf(rows.map((r) => r.creator_account_id || ''));
    const cards = (
      await Promise.all(
        rows.map((row) =>
          cachedDropCard(ctx, cfg, row, row.creator_account_id ? names.get(row.creator_account_id) ?? null : null).catch(
            () => null
          )
        )
      )
    ).filter((c): c is DropCard => c != null && c.status !== 'unconfigured');
    const now = Math.floor(Date.now() / 1000);
    const drops = cards
      .filter((c) => matches(c, filter, now))
      .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
    return NextResponse.json({ drops, usdPerEth: await usdRate(), live: cfg != null });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
