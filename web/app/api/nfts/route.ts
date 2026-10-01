import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { apiErrorBody } from '../../../lib/apiError';
import { listedNfts, loadCollectionStats } from '../../../lib/listedNfts';
import { getWebChain } from '../../../lib/dexServer';

const ROUTE = 'GET /api/nfts';

/**
 * Collections Flizy lists, including the ones this account does not hold.
 *
 * Holdings omit a zero balance. This page is the list a person compares a
 * contract against, so a collection they have not minted still has to be here.
 * Each comes with its stats read from the chain; one that cannot be read is
 * still listed, with its figures left empty.
 */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const collections = await Promise.all(
      listedNfts().map((col) =>
        loadCollectionStats(provider, col).catch(() => ({
          ticker: col.ticker,
          address: col.address,
          name: col.ticker,
          items: null,
          owners: null,
          freeMint: false,
        }))
      )
    );
    return NextResponse.json({ collections });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
