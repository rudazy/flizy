import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { apiErrorBody } from '../../../../../lib/apiError';
import { loadFlzHolders, loadTokenHolders } from '../../../../../lib/tokenHoldersServer';
import { listedTokenKey } from '../../../../../lib/tokenSocial';
import { describeHeldToken } from '../../../../../lib/accountTokens';
import { findEthPair } from '../../../../../lib/tokenMarketServer';

const ROUTE = 'GET /api/tokens/[symbol]/holders';

// The same list for every viewer. Shared for 30 seconds so a caller looping
// this route cannot turn each request into explorer and RPC calls.
const cachedHolders = unstable_cache(() => loadFlzHolders(), ['flz-holders'], {
  revalidate: 30,
});

const cachedTokenHolders = unstable_cache(
  async (address: string, decimals: number) => loadTokenHolders(address, await findEthPair(address).catch(() => null), decimals),
  ['token-holders'],
  { revalidate: 30 }
);

/**
 * Top holders of FLZ, or of a token this account imported or holds. Addresses
 * come from the explorer, amounts from the chain.
 */
export async function GET(_req: Request, { params }: { params: { symbol: string } }) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const raw = String(params.symbol || '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      const described = await describeHeldToken(accountId, raw);
      if ('missing' in described) return NextResponse.json({ error: described.missing }, { status: 404 });
      if ('listedSymbol' in described) return NextResponse.json({ holders: await cachedHolders() });
      return NextResponse.json({ holders: await cachedTokenHolders(described.held.address, described.held.decimals) });
    }
    if (listedTokenKey(raw) !== 'flz') {
      return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    }
    const holders = await cachedHolders();
    return NextResponse.json({ holders });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
