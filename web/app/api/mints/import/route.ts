import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { nftContext, viewerWallet } from '../../../../lib/nftApi.ts';
import { mintConfig } from '../../../../lib/mintDrop.ts';
import { detectExternal, EXTERNAL_MINT_FNS } from '../../../../lib/mintExternal.ts';
import { MAX_DROPS_PER_ACCOUNT, creatorDropCount, insertDrop } from '../../../../lib/mintDrops.ts';
import { MintError } from '../../../../lib/mintExecute.ts';
import {
  artworkUrl,
  chainText,
  clientErrorResponse,
  field,
  pageText,
  readJson,
  routeCollection,
} from '../../../../lib/mintRequest.ts';

const ROUTE = 'POST /api/mints/import';

/**
 * Bring a collection to Flizy. Only the contract's owner() may bring it, so
 * nobody can put someone else's collection on Flizy under their own name.
 * The mint mode comes from the chain, never from the request: Flizy-managed
 * when the contract names FlizyDrop as its minter, Contract-managed when it
 * has a supported public mint function, refused otherwise. No transaction is
 * sent; a Flizy-managed drop is configured afterwards.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await readJson(req);
    const collection = routeCollection(String(field(body, 'collection') || ''));

    const ctx = nftContext();
    const cfg = mintConfig();
    const [d, viewer] = await Promise.all([detectExternal(ctx.provider, collection), viewerWallet(accountId)]);
    if (!d.isContract) throw new MintError('No contract at this address on GIWA Sepolia.');
    if (!d.erc721) throw new MintError('Only ERC-721 collections can mint through Flizy for now.');
    if (!d.owner) throw new MintError('This contract has no owner(), so Flizy cannot confirm it is yours.');
    if (d.owner !== viewer.address) {
      throw new MintError('Only the contract owner can bring this collection to Flizy. Its owner is a different wallet.', 403);
    }

    if ((await creatorDropCount(accountId)) >= MAX_DROPS_PER_ACCOUNT) {
      throw new MintError(`An account can have at most ${MAX_DROPS_PER_ACCOUNT} mints on Flizy.`, 429);
    }

    const managed = cfg != null && d.flizyMinter === cfg.drop;
    // The supported function this drop will call, in the library's preference order.
    const fn = EXTERNAL_MINT_FNS.find((f) => d.mintFns.includes(f)) ?? null;
    if (!managed && !fn) {
      throw new MintError('Flizy found no mint function it supports on this contract (claim, mint, publicMint).');
    }

    const nameRaw = field(body, 'name');
    const name = nameRaw ? chainText(nameRaw, 'Name', 64) : chainText(d.name || '', 'Name', 64);
    const row = await insertDrop({
      collection,
      mode: managed ? 'flizy' : 'external',
      creatorAccountId: accountId,
      name,
      description: pageText(field(body, 'description'), 2000),
      imageUrl: artworkUrl(field(body, 'imageUrl'), 'Artwork', false),
      bannerUrl: artworkUrl(field(body, 'bannerUrl'), 'Banner', false),
      externalMintFn: managed ? null : fn,
    });
    if (!row) throw new MintError('This collection is already on Flizy.', 409);
    return NextResponse.json({ ok: true, collection: row.collection, mode: row.mode });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
