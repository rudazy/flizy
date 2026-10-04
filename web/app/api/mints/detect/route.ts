import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { nftContext, viewerWallet } from '../../../../lib/nftApi.ts';
import { mintConfig } from '../../../../lib/mintDrop.ts';
import { detectExternal } from '../../../../lib/mintExternal.ts';
import { getDrop } from '../../../../lib/mintDrops.ts';
import { verifiedCollection } from '../../../../lib/listedNfts';
import { MintError } from '../../../../lib/mintExecute.ts';
import { clientErrorResponse, routeCollection } from '../../../../lib/mintRequest.ts';

const ROUTE = 'GET /api/mints/detect';

/**
 * "Verify collection" in Bring a collection: what Flizy can read about the
 * contract and how it could mint through Flizy. Read-only.
 *
 *   flizy    : the contract names FlizyDrop as its minter; Flizy manages the mint.
 *   external : a supported public mint function was found; Contract-managed.
 *   none     : neither; Flizy cannot mint this collection.
 * Bringing a collection needs its owner(): `isOwner` says whether that is you.
 */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const collection = routeCollection(new URL(req.url).searchParams.get('collection') || undefined);

    const ctx = nftContext();
    const cfg = mintConfig();
    const [d, viewer, existing] = await Promise.all([
      detectExternal(ctx.provider, collection),
      viewerWallet(accountId),
      getDrop(collection),
    ]);
    if (!d.isContract) throw new MintError('No contract at this address on GIWA Sepolia.');
    if (!d.erc721) throw new MintError('Only ERC-721 collections can mint through Flizy for now.');
    const managed = cfg != null && d.flizyMinter === cfg.drop;
    const mode = managed ? 'flizy' : d.mintFns.length ? 'external' : 'none';
    return NextResponse.json({
      collection,
      name: d.name,
      owner: d.owner,
      isOwner: d.owner != null && d.owner === viewer.address,
      totalSupply: d.totalSupply,
      maxSupply: d.maxSupply,
      priceWei: d.priceWei,
      mintFns: d.mintFns,
      mode,
      verified: verifiedCollection(collection) != null,
      alreadyOnFlizy: existing != null,
      // The minter a contract must name (IFlizyMintable.flizyMinter) to be Flizy-managed.
      flizyDrop: cfg?.drop ?? null,
    });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
