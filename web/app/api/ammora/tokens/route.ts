import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { getWebChain } from '../../../../lib/webChain.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { ammoraEnabled } from '../../../../lib/ammora/venue.ts';
import { listAmmoraTokens } from '../../../../lib/ammora/catalog.ts';

const ROUTE = 'GET /api/ammora/tokens';

/**
 * Ammora launches for Explore and the swap token picker. Off (AMMORA_ENABLED)
 * means 404 and no Ammora call. A Data API failure or an unattested venue is a
 * clean empty list with unavailable: true, never an error page.
 */
export async function GET() {
  try {
    if (!ammoraEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    return NextResponse.json(await listAmmoraTokens(getSupabase(), provider));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
