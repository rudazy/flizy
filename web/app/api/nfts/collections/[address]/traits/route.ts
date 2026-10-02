import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../../lib/apiError';
import { nftContext, routeAddress } from '../../../../../../lib/nftApi.ts';

const ROUTE = 'GET /api/nfts/collections/[address]/traits';
/** Traits are counted over at most this many explorer pages (50 tokens each). */
const MAX_PAGES = 4;

/**
 * Trait types and values with how many tokens carry each, from token metadata.
 * Large collections are sampled; the response says how many tokens were read.
 */
export async function GET(_req: Request, { params }: { params: { address: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const address = routeAddress(params.address);
    if (!address) return NextResponse.json({ error: 'Not a collection address' }, { status: 400 });

    const ctx = nftContext();
    const counts = new Map<string, Map<string, number>>();
    let read = 0;
    let cursor: string | null = null;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await ctx.index.instances(address, cursor);
      for (const item of result.items) {
        read += 1;
        for (const t of item.traits) {
          const values = counts.get(t.trait) ?? new Map<string, number>();
          values.set(t.value, (values.get(t.value) ?? 0) + 1);
          counts.set(t.trait, values);
        }
      }
      if (!result.next) {
        complete = true;
        break;
      }
      cursor = result.next;
    }

    const traits = [...counts.entries()]
      .map(([trait, values]) => ({
        trait,
        values: [...values.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
          .slice(0, 50),
      }))
      .sort((a, b) => a.trait.localeCompare(b.trait));

    return NextResponse.json({ traits, read, complete });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
